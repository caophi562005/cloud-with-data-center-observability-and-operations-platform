# Checklist triển khai AMP và kiểm thử E2E OpsGrid

## Trạng thái và phạm vi

Cập nhật 2026-10-09: đã triển khai AMP và xác minh luồng metrics Linux với VM hiện hữu. Bản sửa alignment trước đó ở API `:6` đã trả dữ liệu cho cả `1h / 6h / 24h / 7d` và cửa sổ lệch 30 giây từng lỗi; xem [báo cáo alignment lịch sử](<.superpowers/sdd/2026-10-09-amp-linux-e2e/api-rollout-live-report.md>).

Sau cleanup được duyệt, API hiện chạy revision `:7` với immutable image mới; Gateway giữ `:2`. ECS/ALB ổn định, UI thật vẫn có dữ liệu cả bốn preset, Google login giả và onboarding mẫu đã bỏ; xem [nghiệm thu cleanup/rollout/UI mới nhất](<.superpowers/sdd/2026-10-09-cleanup-rollout/report.md>). **Chưa nghiệm thu toàn bộ checklist**: CVE/hardening, tenant A/B, security/fault/recovery matrix, Windows và Grafana logs vẫn chưa xác minh. Các mục bên dưới là tiêu chí đề xuất, không mặc định đã thực hiện và không tự cấp quyền apply/deploy/test.

Không cần tạo script test hạ tầng; dùng Terraform CLI trực tiếp. Các bước publish, apply, ghi metrics, tạo tải, ngắt dependency, restart và cleanup chỉ thực hiện sau khi được duyệt tương ứng.

```text
UI / Cognito → API tạo VM và enrollment token
                       ↓
                VM Linux / Windows
                       ↓
                    Alloy
                       ↓ HTTPS + AGT
                  ECS Gateway
                       ↓ localhost
                 SigV4 sidecar
                       ↓
                  AMP workspace
                       ↑
                 SigV4 sidecar
                       ↑ localhost
                     API
                       ↓
                UI current / charts
```

## 1. Chuẩn bị môi trường và dữ liệu test

- Chốt AWS account/region hiện tại: `ap-southeast-1`.
- Chuẩn bị **hai organization A/B**, tài khoản có quyền phù hợp và VM test riêng:
  - Ít nhất một Linux.
  - Một Windows nếu muốn nghiệm thu cả hai nền tảng.
- Kiểm tra API và Gateway dùng cùng nguồn dữ liệu control-plane; Gateway dùng DB role chỉ đọc.
- Kiểm tra schema/migrations cần thiết. Nếu thiếu, review migration trước khi chạy `prisma:migrate:deploy`; không reset/seed tùy tiện database đang dùng.
- Chuẩn bị quyền build/publish image, Terraform apply, ACM/DNS và CloudWatch log delivery.
- Không đưa enrollment token, AGT, cookie, DB/Redis credentials vào log hoặc báo cáo.

**Đầu ra:** môi trường test rõ ràng, dữ liệu test tách biệt, danh sách thao tác có ghi/xóa tài nguyên được duyệt.

## 2. Chạy regression trước khi publish image

Dùng các lệnh có sẵn trong [API package](<apps/api/package.json>):

```powershell
pnpm -C apps/api typecheck
pnpm -C apps/api test
pnpm -C apps/api test:e2e
pnpm -C apps/api build

pnpm -C apps/web test
pnpm -C apps/web build
```

Gateway: từ `apps/ingest`, chạy nhóm non-smoke đã xác định:

```text
go test -count=1 ./internal/auth ./internal/cache ./internal/config ./internal/ratelimit ./internal/remotewrite ./internal/repository/postgres ./internal/server ./internal/upstream
go vet ./...
```

**Phân biệt:** [VM metrics E2E hiện có](<apps/api/test/vm-metrics.e2e-spec.ts>) dùng dependencies được kiểm soát/mocked. Pass suite này **không chứng minh ECS → AMP hoặc VM → UI hoạt động**.

Nếu muốn kiểm tra container integration trước deployment, có thể review và chạy runner image-smoke đã có, sau khi được duyệt riêng. Không cần viết runner mới dưới `infra/`.

## 3. Build và publish image mới

Build từ source hiện tại, đúng context của [API Dockerfile](<apps/api/Dockerfile>) và [Gateway Dockerfile](<apps/ingest/Dockerfile>):

```powershell
docker build --platform linux/amd64 -t opsgrid-api:amp `
  -f apps/api/Dockerfile apps/api

docker build --platform linux/amd64 -t opsgrid-ingest:amp `
  -f apps/ingest/Dockerfile apps/ingest
```

Sau đó:

1. Tag/push vào ECR Public đang sử dụng.
2. Lấy **registry manifest digest** của image đã publish.
3. Ghi nhận mapping source snapshot → image digest.
4. Không dùng lại digest ví dụ cũ nếu chưa chứng minh image đó hỗ trợ:
   - `none|basic|bearer`.
   - HTTP loopback.
   - Cấu hình AMP hiện tại.
5. Review scan findings và proxy v1.13 đang dùng AWS SDK Go V1 hết hỗ trợ.

**Pass:** có hai digest mới, immutable, đúng `linux/amd64`, không chứa runtime secrets.

## 4. Tạo workspace AMP persistent

Từ workspace root, dùng thư mục plan private hiện có:

```powershell
$private = (Resolve-Path ".superpowers/private/amp-wiring").Path

terraform -chdir=infra/terraform/environments/dev/persistent init -input=false -lockfile=readonly
terraform -chdir=infra/terraform/environments/dev/persistent validate
terraform -chdir=infra/terraform/environments/dev/persistent plan -input=false "-out=$private\persistent-real.tfplan"
```

Review **plan mới**, không mặc định kết quả vẫn giống plan trước. Dự kiến phần AMP gồm workspace và log group; dừng nếu có thay đổi ngoài phạm vi chưa được duyệt.

Chỉ sau khi được duyệt apply:

```powershell
terraform -chdir=infra/terraform/environments/dev/persistent apply "$private\persistent-real.tfplan"
terraform -chdir=infra/terraform/environments/dev/persistent output -raw amp_workspace_arn
```

Kiểm tra:

- Workspace đạt trạng thái `ACTIVE`.
- Region/account đúng.
- Logging được cấu hình thành công; không vướng quyền delivery policy hoặc quota.
- Lấy **ARN thật**, tuyệt đối không dùng ARN zero-UUID trong plan giả định.

## 5. Cấu hình và deploy API/Gateway lên ECS

Cập nhật cấu hình private đang sử dụng, theo [các input AMP](<infra/terraform/environments/dev/test/amp.tf>) và [example triển khai](<infra/terraform/environments/dev/test/terraform.tfvars.example#L52-L68>):

| Input | Giá trị cần chốt |
|---|---|
| `amp_workspace_arn` | ARN workspace thật |
| `image_digest_uri` | API digest mới |
| `enable_ingest` | `true` |
| `ingest_image_digest_uri` | Gateway digest mới |
| `ingest_certificate_arn` | Certificate ACM phù hợp hostname Gateway |
| DB/Redis/Cognito/`WEB_URL` | Runtime configuration đúng môi trường |

Lưu ý:

- Gateway không có certificate thì mới là HTTP setup; **chưa đủ điều kiện truyền AGT cho E2E**.
- AMP tự inject mode `none` và localhost URL; không cần static AWS access keys hoặc Basic/Bearer AMP token.
- Tăng runtime secret-version tương ứng nếu thay đổi giá trị write-only.
- Không ghi đè toàn bộ private configuration bằng example.

Chạy plan mới:

```powershell
terraform -chdir=infra/terraform/environments/dev/test init -input=false -lockfile=readonly
terraform -chdir=infra/terraform/environments/dev/test validate
terraform -chdir=infra/terraform/environments/dev/test plan -input=false "-out=$private\test-real.tfplan"
```

Sau review/approval mới apply:

```powershell
terraform -chdir=infra/terraform/environments/dev/test apply "$private\test-real.tfplan"
```

**Pass deployment:**

- Hai ECS services ổn định, ALB targets healthy.
- Mỗi task có application + `amp-sigv4`.
- Sidecar đúng digest, nonroot/read-only, không có port mapping/public ingress.
- Không còn inject legacy metrics credentials vào application.
- Đọc policy **đã deploy** để xác nhận API chỉ query, Gateway chỉ remote-write, scope workspace thật. Plan trước chưa resolve concrete IAM JSON.
- Không có OOM/restart loop; kiểm tra tài nguyên thực tế, không chỉ dựa vào budget Terraform.

## 6. Kiểm tra routing, HTTPS và installer

### API/Gateway

- API: `GET /api/v1/health`.
- Gateway: `GET /health` và `GET /ready`.
- DNS/certificate hợp lệ; không dùng tùy chọn bỏ xác minh TLS.

**Health xanh chưa chứng minh AMP hoạt động:** API health kiểm tra DB/Redis; Gateway readiness kiểm tra PostgreSQL, không probe AMP.

### UI OpsGrid

[HTTP client hiện tại](<apps/web/src/lib/api/http-client.ts#L3-L37>) gọi `/api/v1` tương đối và gửi cookie:

- Production: kiểm tra CloudFront/reverse proxy route `/api/*` đến đúng API.
- Local: [Vite proxy](<apps/web/vite.config.ts#L10-L15>) hiện trỏ `localhost:3000`; cần điều chỉnh nếu kiểm tra API cloud.
- Kiểm tra login, cookies, refresh, `WEB_URL`/CORS phù hợp topology.

**Không mặc định cần sửa/build lại frontend chỉ vì đổi backend metrics.** Chỉ triển khai web mới nếu source hoặc routing/configuration cần đổi.

### Installer/Alloy

- Kiểm tra endpoint installer mà UI tạo command sử dụng.
- Enrollment phải vào API mới.
- Remote-write thực tế phải đến **Gateway ECS AWS**, không vô tình tiếp tục gửi sang Gateway Azure cũ.
- Nếu artifact installer/configuration còn trỏ endpoint cũ, cập nhật và publish phần đó trước E2E.

## 7. E2E happy path: VM → AMP → API → UI

Thực hiện lần lượt cho Linux, rồi Windows:

1. Login bằng tài khoản organization A.
2. Tạo VM test, ghi nhận `organizationId`, `vmId`.
3. Issue enrollment token và chạy command cài agent từ UI.
4. Xác nhận enrollment thành công, agent `ACTIVE`; lưu credential đúng quyền truy cập.
5. Xác nhận Alloy/exporter hoạt động, thời gian VM được đồng bộ.
6. Xác nhận Alloy gửi Remote Write v1 đến Gateway qua HTTPS + AGT.
7. Xác nhận Gateway nhận và forward thành công.
8. Kiểm tra **sample xuất hiện trong AMP**, đúng ba trusted labels:
   - `organization_id`
   - `vm_id`
   - `agent_id`
9. Gọi API bằng session user thật:

   ```text
   GET /api/v1/organizations/{organizationId}/vms/{vmId}/metrics/current
   GET /api/v1/organizations/{organizationId}/vms/{vmId}/metrics/range?range=1h
   ```

10. Mở VM detail trên UI, đối chiếu current metrics/charts với API response.

**Tiêu chí pass:**

- Gateway `204` **và** query thấy sample; `204` riêng lẻ chỉ chứng minh upstream chấp nhận write.
- Timestamp là sample mới, không phải dữ liệu cũ.
- CPU/RAM/disk/network/uptime có giá trị phù hợp hệ điều hành.
- Windows không có Linux load metric: UI phải thể hiện unsupported, không giả thành `0`.
- Có nhiều sample để kiểm tra charts/rate; không nghiệm thu chỉ bằng một sample.
- Presets `1h`, `6h`, `24h`, `7d` hoạt động. VM mới không cần có đủ bảy ngày dữ liệu để pass.

## 8. Ma trận E2E bắt buộc

| Nhóm | Thao tác | Kết quả cần đạt |
|---|---|---|
| Authentication | Không có/sai AGT | Gateway `401`, không forward |
| Enrollment | Token hết hạn/đã dùng/sai VM | Bị từ chối, không tạo agent trái phép |
| Tenant isolation | User A truy cập VM organization B | Bị chặn, không lộ metadata/metrics |
| Trusted labels | Payload dùng AGT A nhưng giả labels của B | Gateway overwrite về binding A; không xuất hiện dưới B |
| Revocation | Revoke agent rồi tiếp tục gửi | Bị từ chối sau giới hạn cache TTL; không yêu cầu tức thì nếu cache còn hợp lệ |
| Re-enrollment | Enrollment lại hợp lệ | API bind agent mới; không trộn series agent cũ |
| Freshness | Dừng Alloy | Sau stale threshold và polling/cache, VM `DISCONNECTED`; current metrics không giả thành zero |
| Recovery | Khởi động Alloy lại | Sample mới xuất hiện, trạng thái phục hồi |
| Health status | Tạo tải có giới hạn trên VM test | `WARNING`/`CRITICAL` đúng ngưỡng, phục hồi khi giảm tải |
| Range validation | Range sai hoặc window quá lớn | `400`; không query không giới hạn |
| Missing data | Một metric family thiếu | Metric đó null/gap, không làm sai toàn bộ VM |
| Charts | Có khoảng gián đoạn telemetry | UI thể hiện gap, không nối giả hoặc fill zero |
| Browser isolation | Chuyển A → B, logout/login | Không giữ metrics/cache của tenant cũ |
| Protocol | Sai encoding/protobuf/version | Bị từ chối đúng contract, không forward |
| Body/rate limits | Vượt body/rate limit trong test có giới hạn | `413`/`429`, không làm sập service |
| AMP failure | Fault injection được duyệt riêng | Gateway không false ACK; API báo lỗi an toàn, UI không giả “không có dữ liệu” |
| Redis failure | Gián đoạn Redis có kiểm soát | Gateway fallback DB; không bypass auth |
| Dependency failure | Không xác thực được từ DB/cache | Fail closed, không chấp nhận credential chưa xác minh |
| ECS recovery | Restart/redeploy có kiểm soát | Agent retry/WAL hoạt động, services phục hồi |
| Secret hygiene | Review logs, responses, evidence | Không có AGT, cookie, Authorization, runtime secrets hoặc raw upstream error |

Theo [policy mặc định hiện tại](<apps/api/src/config/env.schema.ts#L3-L9>): stale **300 giây**, CPU warning **80%**, RAM/disk warning **85%**, critical **95%**. Khi test phải tính thêm cache/polling và dùng cấu hình **thực tế đã deploy**.

Các test tạo tải, ngắt dependency, thay IAM hoặc restart cần duyệt riêng; không làm trên production. Không ghi đầy disk hoặc phá dependency dùng chung để thử.

## 9. Khoanh vùng lỗi và chốt nghiệm thu

### Thứ tự debug

| Triệu chứng | Kiểm tra trước |
|---|---|
| Alloy không gửi được | Enrollment, AGT, service/config, DNS/TLS, endpoint AWS/Azure |
| Gateway `401` | Agent status/binding, DB lookup, auth-cache TTL |
| Gateway `502` | Signer có chạy không, flags/region, TaskRole, AMP response, network |
| Gateway `204` nhưng không thấy sample | Workspace, timestamp/clock, labels, ingestion delay/query selector |
| AMP có sample nhưng API lỗi | API signer/query IAM, workspace/base URL, binding agent/VM |
| API đúng nhưng UI sai | `/api/*` routing, cookies/permissions, tenant query keys, parsing/chart rendering |

Không tìm `/health` giả trên signer hoặc dùng `curl` trong scratch image. Dùng application requests, ECS events và CloudWatch logs đã redacted.

### Hồ sơ nghiệm thu

Ghi nhận:

- Workspace ARN thật, image digests và ECS task-definition revisions.
- Plan/apply receipts được bảo vệ; không publish raw plans/state.
- Từng case: `PASS / FAIL / NOT RUN`, thời gian UTC, request ID và evidence đã redacted.
- Screenshot UI cùng API/sample timestamps tương ứng.
- Các lỗi được sửa và kết quả rerun.
- Quy trình rollback **image + configuration tương thích**, không chỉ đổi về image cũ vốn chưa hỗ trợ AMP.
- Cleanup VM/agent/data test; chỉ destroy stack temporary khi được duyệt, không destroy persistent workspace.

**Chỉ gọi là hoàn thiện khi:** happy path live pass, tenant/auth/revocation pass, UI Linux/Windows đúng phạm vi hỗ trợ, lỗi dependency không false ACK/leak secrets, và mọi case chưa chạy được ghi rõ—không coi unit tests hoặc Terraform plan là E2E live.

# INTRODUCT — Cloud & Data Center Observability and Operations Platform

## 1. Tên đề tài

**Tiếng Việt:** Xây dựng hệ thống giám sát máy chủ, Cloud và trung tâm dữ liệu  
**English:** Cloud & Data Center Observability and Operations Platform

## 2. Giới thiệu

Đề tài xây dựng một nền tảng tập trung để giám sát và vận hành máy chủ, máy ảo, Cloud và trung tâm dữ liệu. Hệ thống sử dụng **React** làm giao diện chính và **NestJS** làm backend/control plane, cho phép quản lý tài nguyên, theo dõi metrics, cảnh báo và sự cố, kết nối Cloud, thực thi runbook tự động và mở rộng sang AIOps với **Jev**.

Hệ thống được thiết kế **tenant-aware ngay từ đầu**, nhưng chỉ triển khai full multi-tenant ở giai đoạn cuối. Phiên bản đầu ưu tiên **VM monitoring** để nhanh chóng có một luồng demo end-to-end hoàn chỉnh.

## 3. Kiến trúc định hướng

```text
Users
  |
  v
React Web
  |
  v
NestJS API / Control Plane
  |
  +--> PostgreSQL
  +--> Metrics / Observability Backend
  +--> Redis / Job Queue --> Worker
  +--> Cloud Connectors
  +--> Jev / AIOps
```

Cấu trúc repository dự kiến:

```text
cloudops/
├── apps/
│   ├── web/          # React + Vite
│   ├── api/          # NestJS
│   └── worker/       # thêm ở Phase 6
├── packages/
│   ├── contracts/
│   └── config/
├── infra/
├── deploy/
└── docs/
```

Giai đoạn đầu dùng **pnpm workspace**; chưa bắt buộc dùng Nx.

---

# 4. Roadmap triển khai

## Phase 0 — Project Foundation

**Mục tiêu:** tạo nền móng kỹ thuật cho toàn bộ hệ thống.

### Phạm vi
- React + Vite frontend.
- NestJS backend.
- PostgreSQL.
- Docker Compose cho môi trường local.
- Shared contracts/types giữa frontend và backend.
- Lint, format, test và CI cơ bản.
- Monorepo bằng pnpm workspace.

### Kết quả
Frontend, backend và database giao tiếp được end-to-end; project có cấu trúc ổn định để phát triển tiếp.

---

## Phase 1 — Identity, Organization & RBAC

**Mục tiêu:** xây dựng xác thực và nền tảng tenant-aware trước khi thêm tài nguyên giám sát.

### Phạm vi
- Authentication.
- User.
- Organization/Tenant.
- Membership.
- Role: `Admin`, `Operator`, `Viewer`.
- Authorization trên backend.
- Resource quan trọng có `organization_id`.

### Kết quả
Người dùng đăng nhập được, thuộc một organization và chỉ truy cập tài nguyên theo quyền được cấp.

> Phase này chưa cần full multi-tenant. Có thể chỉ dùng một organization demo nhưng data model phải sẵn sàng cho nhiều tenant.

---

## Phase 2 — VM Monitoring MVP

**Mục tiêu:** hoàn thiện luồng giám sát VM end-to-end, hỗ trợ VM on-prem/remote khác network mà không cần mở inbound port.

### Phạm vi

#### VM Inventory
- Thêm/xóa/cập nhật VM.
- Hostname, IP, OS.
- Tags theo dạng `key:value`, ví dụ `env:production`, `role:database`, `site:hcm`.
- Thêm/sửa/xóa tag và lọc VM theo tag.
- Health status: `Healthy`, `Warning`, `Critical`, `Disconnected`.

#### Agent Enrollment
- Khi tạo VM, NestJS sinh enrollment token dùng một lần.
- Người dùng chạy install script trên VM để cài **Grafana Alloy**.
- Alloy nhận agent token riêng và gửi metrics ra ngoài bằng HTTPS.

#### Metrics Collection
Thu thập:
- CPU.
- RAM.
- Disk.
- Network.
- Load.
- Uptime.

Alloy gửi metrics bằng **Prometheus Remote Write** qua HTTPS `443` tới **Ingestion Gateway**.

#### Ingestion Gateway
- Xác thực agent token.
- Xác định `vm_id` và `organization_id`.
- Gắn trusted labels cho metrics.
- Validate/rate limit cơ bản.
- Forward metrics vào **AWS AMP** qua **`aws-sigv4-proxy` sidecar** của Ingestion Gateway trên ECS Fargate (AWS IAM/SigV4).

#### Data Storage
- **Neon/PostgreSQL:** VM inventory, organization, tags, agent metadata và enrollment token metadata.
- **AWS AMP:** metrics time-series theo Prometheus-compatible API.
- Không lưu CPU/RAM/Disk history trong PostgreSQL.

#### React Monitoring Dashboard
- Danh sách VM.
- Healthy / Warning / Critical / Disconnected.
- CPU/RAM/Disk cards.
- Time-series charts.
- Trang chi tiết từng VM.
- Filter theo tags.

### Luồng

```text
Add VM
  |
  v
NestJS --> Neon/PostgreSQL
  |
  +--> Enrollment Token
          |
          v
      Install Alloy on VM
          |
          | HTTPS 443 / Remote Write
          v
   Ingestion Gateway (Go)
          |
          v
   SigV4 sidecar (ECS)
          |
          v
       AWS AMP <--- SigV4 sidecar (API ECS) <--- NestJS API <--- React Dashboard
```

### Kết quả
Có thể demo nhiều VM ở cùng hoặc khác network, kể cả VM private/on-prem sau NAT, miễn VM có outbound HTTPS. Dashboard theo dõi CPU, RAM, Disk, Network, Load, Uptime và lọc VM theo tags.

**Đây là milestone demo đầu tiên của dự án.**

---

## Phase 3 — AWS AMP Alerting & Alert Operations

**Mục tiêu:** mở rộng VM Monitoring thành hệ thống cảnh báo và tiếp nhận cảnh báo vận hành ngay trên React. Phase này theo hướng **alert-centric, gọn như SigNoz**: tập trung vào trạng thái cảnh báo, mức độ nghiêm trọng, acknowledge, comment và lịch sử; **chưa xây Incident Management**.

### Kiến trúc đã chọn

- **Amazon Managed Service for Prometheus (AWS AMP)** lưu metrics, evaluate Prometheus alert rules và cung cấp **Managed Alertmanager**. Không self-host Prometheus hay Alertmanager cho Phase 3.
- **Grafana Alloy** gửi Prometheus Remote Write qua **Ingestion Gateway (Go)**; Gateway forward tới AMP bằng **`aws-sigv4-proxy` sidecar** và **ECS Task Role** (`aps:RemoteWrite`).
- **NestJS API** query metrics AMP qua `aws-sigv4-proxy` sidecar trong ECS task của API. Ứng dụng chỉ dùng Prometheus-compatible HTTP API và `auth=none` khi gọi `localhost`; sidecar đảm nhiệm AWS SigV4. Không hardcode AWS access key/secret key trong ứng dụng.
- **AMP Rule Groups** đánh giá alert rules; **AMP Managed Alertmanager** group/dedup/route notification đến **Amazon SNS Standard Topic**.
- **Amazon SNS** chuyển notification qua **HTTPS subscription** đến NestJS; NestJS xác thực SNS, chuyển payload về domain Alert rồi lưu **PostgreSQL**.
- **React + PxlKit** là giao diện chính để xem cảnh báo, acknowledge và ghi chú. Không dùng Grafana UI làm UI vận hành.

```text
VM / Grafana Alloy
        |
        | Prometheus Remote Write / HTTPS
        v
Ingestion Gateway (Go) + SigV4 sidecar (ECS)
        |
        v
AWS AMP Workspace (metrics)
        |
        v
AMP Rule Group Namespace (PromQL alert rules)
        |
        v
AMP Managed Alertmanager (group / dedup / route)
        |
        v
Amazon SNS Standard Topic
        |
        | HTTPS subscription / SNS Notification
        v
NestJS (verify SNS -> CanonicalAlertEvent -> AlertService)
        |
        v
PostgreSQL (alerts, alert_events)
        |
        v
React Alerts UI (PxlKit)

Luồng query monitoring song song:
React Monitoring UI -> NestJS API -> SigV4 sidecar (API ECS task) -> AMP Query API
```

### 5 bước triển khai

#### Bước 1 — AMP Integration
- Tái sử dụng AMP workspace và infrastructure Terraform hiện có.
- Ingestion Gateway remote-write metrics vào AMP; NestJS query AMP qua các **SigV4 sidecar** trong ECS Fargate tasks tương ứng.
- Kiểm tra luồng Alloy -> Gateway -> AMP và React -> NestJS -> AMP query hoạt động end-to-end.

#### Bước 2 — AMP Alerting Infrastructure & Alert Rules
- Terraform quản lý **AMP Rule Group Namespace**, **AMP Alertmanager Definition**, **SNS Standard Topic** và các IAM/SNS topic policy tối thiểu để AMP gửi notification.
- Tạo bộ rule VM đầu tiên: `VMHighCPU`, `VMHighMemory`, `VMDiskUsageHigh`, `VMDisconnected`; **PromQL phải dựa vào metric/label thực tế đang gửi vào AMP**, không tự giả định metric chưa tồn tại.
- Rule dùng `for` để tránh spike ngắn, nhãn `severity` (`warning`, `critical`), cùng `organization_id`, `vm_id`/resource labels mà Gateway đã gắn đáng tin cậy.
- AMP Managed Alertmanager làm grouping/dedup/routing; ưu tiên SNS message dạng **JSON có cấu trúc** để NestJS xử lý.
- Không cài thêm Alertmanager container; không làm SNS subscription/NestJS ingestion trong bước này.

#### Bước 3 — SNS -> NestJS Alert Ingestion
- NestJS có HTTPS endpoint nhận `SubscriptionConfirmation` và `Notification` từ SNS, thực hiện confirmation an toàn khi tạo subscription.
- **Xác minh SNS signature và expected `TopicArn` trước khi tin payload**; xử lý message sai định dạng an toàn.
- Chuyển SNS/AMP payload thành `CanonicalAlertEvent` với fingerprint, `FIRING`/`RESOLVED`, organization, VM/resource, severity, timestamps, labels và annotations; không để Alert business logic phụ thuộc cấu trúc AWS SNS.
- Lưu `alerts` và `alert_events` trong PostgreSQL; xử lý retry/idempotency, không tạo duplicate alert hoặc history event cho cùng message/lifecycle.
- Terraform tạo **SNS HTTPS subscription** tới endpoint NestJS hiện có; không thêm Lambda/SQS nếu chưa có nhu cầu.

#### Bước 4 — Alert Operations (alert-centric)
- Phân biệt **signal status** (`FIRING`, `RESOLVED`) và **workflow status** (`OPEN`, `ACKNOWLEDGED`); `RESOLVED` đến từ AMP, không phải nút người dùng đóng alert.
- **Acknowledge** nghĩa là operator đã tiếp nhận alert: lưu `acknowledged_by`, `acknowledged_at` và event; không đồng nghĩa với silence AMP hoặc sửa alert rule.
- Operator có thể thêm comment/note. Lưu lịch sử dạng append-only như `ALERT_FIRING`, `ACKNOWLEDGED`, `COMMENT_ADDED`, `ALERT_RESOLVED`.
- Dùng severity `WARNING`/`CRITICAL` từ rule để hiển thị, lọc và ưu tiên xử lý; không làm severity editor ở giai đoạn này.
- Áp dụng RBAC hiện có: `Viewer` chỉ đọc; `Operator`/`Admin` được acknowledge và comment. Tất cả truy vấn/thao tác được scope theo organization hiện tại.

#### Bước 5 — React Alerting UI & End-to-End Validation
- Sử dụng **React + PxlKit và hệ thống icon PxlKit**; giữ theme/design tokens/layout của ứng dụng. Không thêm UI library mới nếu PxlKit đã hỗ trợ.
- **Header bell** hiển thị badge đếm các alert `FIRING + OPEN` thuộc organization hiện tại; click mở popover các alert cần xử lý và nút **View all alerts** tới `/alerts`.
- Trang **`/alerts`** có tab **Firing** và **History**, search/filter theo severity, workflow status và VM/resource; click alert mở **drawer từ bên phải** phủ lên trang hiện tại, không làm mất filter/scroll context.
- **Alert Detail Drawer** dùng chung từ bell hoặc danh sách: summary, severity, status, VM, started/resolved time, labels/annotations, **Acknowledge**, comments, event history và liên kết tới VM detail.
- Trang **`/alert-rules`** chỉ **read-only**: danh sách rule AMP, PromQL, severity, `for`, labels, annotations và rule detail drawer (nếu NestJS có hoặc bổ sung được API đọc phù hợp). **Terraform là source of truth** cho rules; không tạo UI chỉnh sửa rules dễ bị `terraform apply` ghi đè.
- Kiểm thử E2E với VM thật: điều kiện metric vượt ngưỡng -> AMP `FIRING` -> SNS -> PostgreSQL -> bell/list/drawer hiển thị -> operator acknowledge/comment -> AMP `RESOLVED` -> alert chuyển sang History và giữ nguyên lịch sử.

### Alert data và hành vi cốt lõi

```text
Technical signal: FIRING  --------> RESOLVED (AMP quyết định)
Workflow:        OPEN    --------> ACKNOWLEDGED (operator quyết định)
```

- Một alert có thể đang `FIRING + ACKNOWLEDGED`, hoặc đã `RESOLVED + ACKNOWLEDGED`.
- **Acknowledge không làm dừng evaluation/notification của AMP** và không tự giải quyết metric bất thường; muốn silence notification cần thao tác Alertmanager riêng, ngoài scope UI này.
- `alerts` chứa trạng thái hiện tại, liên kết `organization_id`/VM/resource và fingerprint; `alert_events` lưu lịch sử thay đổi và comment. Metrics time-series tiếp tục được lưu ở **AWS AMP**, không ghi lịch sử CPU/RAM/Disk vào PostgreSQL.
- Không tự động tạo một record nghiệp vụ mới mỗi lần AMP/SNS gửi lại notification; phải xử lý idempotent và phân biệt các lần phát cảnh báo sau khi đã resolved.

### Ngoài phạm vi Phase 3
- **Không xây** `incidents`, `incident_alerts`, incident assignment, incident timeline, incident resolve/close hoặc postmortem.
- Không làm AI correlation/Jev, runbook automation, escalation workflow phức tạp hay full alert-rule editor trong React.
- Incident Management chỉ được cân nhắc ở giai đoạn sau hoặc qua tích hợp công cụ chuyên dụng khi thật sự cần; Phase 7 có thể mở rộng correlation/incident trên nền tảng Alert hiện có.

### Kết quả / Definition of Done

- AMP nhận và query được metrics; PromQL alert rules hoạt động, có `FIRING`/`RESOLVED`.
- AMP Managed Alertmanager gửi notification qua SNS; NestJS xác minh, chuẩn hóa và lưu alert không duplicate.
- Operator thấy alert theo organization, severity và resource; acknowledge, thêm comment và xem history trên React.
- Header bell, Alert List, Alert Detail Drawer và Alert Rules read-only hoạt động với dữ liệu/API thực.
- Luồng **metric bất thường -> rule -> AMP Alertmanager -> SNS -> NestJS -> PostgreSQL -> React -> acknowledge/comment -> resolved/history** được kiểm chứng end-to-end.

**Milestone Phase 3:** **Operational Alerting MVP = VM Monitoring + AMP Alerts + Alert Operations** (chưa bao gồm Incident Management).

---

## Phase 4 — Full Observability

**Mục tiêu:** mở rộng từ infrastructure monitoring sang observability cho cả hạ tầng và ứng dụng.

### Phạm vi

#### Metrics
- Infrastructure metrics.
- Application metrics.
- Request rate.
- Error rate.
- Latency.
- Database latency.

#### Centralized Logging
- Thu thập log từ VM và application.
- Search/filter theo resource, service, severity và thời gian.

#### Distributed Tracing
- OpenTelemetry.
- Theo dõi request qua nhiều service.
- Phát hiện bottleneck.

### Kết quả

```text
Metrics + Logs + Traces
          |
          v
     Observability
```

Hệ thống có khả năng hỗ trợ điều tra nguyên nhân sự cố thay vì chỉ hiển thị trạng thái máy chủ.

---

## Phase 5 — Cloud & Kubernetes Integration

**Mục tiêu:** hoàn thiện phần cốt lõi của Server + Cloud + Data Center Monitoring.

### AWS Integration
- Cloud Connection.
- Resource discovery.
- EC2.
- RDS.
- Load Balancer.
- EKS.
- Cloud metrics.

### Cross-account AWS
- STS AssumeRole.
- External ID theo organization khi cần.
- Không lưu permanent access key của tài khoản bên ngoài.

### Kubernetes
Theo dõi:
- Cluster.
- Nodes.
- Namespaces.
- Deployments.
- Pods.
- Containers.
- Restarts.
- Resource usage.
- Health status.

### Unified Resource Inventory

```text
Resources
├── On-prem VM
├── AWS EC2
├── AWS RDS
├── Kubernetes Cluster
└── Container / Service
```

### Kết quả
Hệ thống có thể giám sát tài nguyên từ Data Center, remote VM và Cloud account khác nhau trên cùng một giao diện.

**Đến cuối Phase 5, phần cốt lõi của đề tài đã hoàn chỉnh.**

---

## Phase 6 — Automation & Runbooks

**Mục tiêu:** hỗ trợ xử lý sự cố có kiểm soát.

### Phạm vi
- Redis/Job Queue.
- Worker service.
- Runbook library.
- Human approval.
- Execute.
- Verify result.
- Audit execution.

### Runbook ví dụ
- Restart service.
- Restart container.
- Cleanup disk.
- Collect diagnostics.
- Scale deployment.
- Health check.

### Luồng

```text
Alert
  |
  v
Suggested Runbook
  |
  v
Operator Approval
  |
  v
Worker
  |
  v
Automation
  |
  v
Verification
```

### Kết quả
Platform không chỉ phát hiện lỗi mà còn hỗ trợ xử lý lỗi theo quy trình an toàn.

---

## Phase 7 — Jev & AIOps

**Mục tiêu:** sử dụng Jev như một decision engine tốc độ cao cho hoạt động vận hành.

### Jev Decision Modules
- Severity classification.
- Alert/incident routing.
- Create / ignore / escalate decision.
- Runbook selection.
- Action gating.

### Event Correlation
Kết hợp nhiều tín hiệu liên quan thành một incident thay vì tạo nhiều alert rời rạc.

```text
DB CPU High
API Latency High
HTTP 5xx High
Service Unhealthy
        |
        v
 Event Correlation
        |
        v
 Single Incident
```

### AIOps Workflow

```text
Metrics / Alerts / Events
          |
          v
 Correlation Engine
          |
          v
        Jev
          |
    +-----+------+
    |     |      |
Severity Route Runbook
    |     |      |
    +-----+------+
          |
          v
       Incident
          |
          v
 Human Approval
          |
          v
     Automation
```

### Kết quả
AI hỗ trợ quyết định vận hành có cấu trúc thay vì chỉ đóng vai trò chatbot.

---

## Phase 8 — Multi-Tenant & Enterprise Hardening

**Mục tiêu:** nâng platform từ project demo thành kiến trúc gần với hệ thống enterprise.

### Multi-Tenant

```text
Tenant / Organization
├── Users
├── Roles
├── Resources
├── Cloud Connections
├── Metrics
├── Logs
├── Alerts
├── Incidents
└── Runbooks
```

Mỗi organization chỉ được truy cập dữ liệu và tài nguyên của chính mình.

### Enterprise Hardening
- Audit log.
- Secrets management.
- TLS.
- Rate limiting.
- Backup & restore.
- Data retention.
- High availability.
- Security hardening.
- Terraform/IaC.
- Production CI/CD.
- Deployment automation.

### Kết quả
Platform có khả năng mở rộng cho nhiều tổ chức, nhiều tài khoản Cloud và nhiều môi trường hạ tầng.

---

# 5. Các mốc hoàn thiện

| Mốc | Phạm vi | Kết quả |
|---|---|---|
| **MVP** | Phase 0 → 2 | VM monitoring chạy thật trên React |
| **Operational Alerting MVP** | Phase 0 → 3 | VM monitoring + AMP alert rules/notification + acknowledge/comments/history (chưa Incident Management) |
| **Observability Platform** | Phase 0 → 4 | Metrics + logs + traces |
| **VNPT Core Target** | Phase 0 → 5 | Server + Cloud + Data Center Monitoring |
| **Advanced Platform** | Phase 0 → 6 | Automation + runbooks |
| **AI/AIOps Platform** | Phase 0 → 7 | Jev + event correlation |
| **Enterprise Version** | Phase 0 → 8 | Multi-tenant + production hardening |

## 6. Nguyên tắc triển khai

- Hoàn thành từng phase theo luồng end-to-end trước khi mở rộng.
- Ưu tiên VM monitoring sớm để có sản phẩm demo nhanh.
- React là giao diện chính của toàn bộ platform.
- NestJS là control plane; frontend không truy cập trực tiếp dữ liệu nhạy cảm hay query observability backend tùy ý.
- Thiết kế tenant-aware từ đầu nhưng trì hoãn full multi-tenant cho đến khi core monitoring ổn định.
- Automation mặc định có human approval.
- Chỉ thêm Jev khi hệ thống đã có metrics và alert context ổn định; bổ sung incident/correlation khi thực sự cần ở giai đoạn sau.

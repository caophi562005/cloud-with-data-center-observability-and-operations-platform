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

**Mục tiêu:** tạo phiên bản demo đầu tiên và hoàn thiện luồng giám sát VM.

### Phạm vi

#### VM Inventory
- Thêm/xóa/cập nhật VM.
- Hostname, IP, OS, environment, tags.
- Health status.

#### Metrics Collection
Thu thập:
- CPU.
- RAM.
- Disk.
- Network.
- Load.
- Uptime.

Có thể bắt đầu bằng Node Exporter/agent và Prometheus-compatible metrics backend.

#### React Monitoring Dashboard
- Danh sách VM.
- Healthy / Warning / Critical.
- CPU/RAM/Disk cards.
- Time-series charts.
- Trang chi tiết từng VM.

### Luồng

```text
VM
 |
 v
Exporter / Agent
 |
 v
Metrics Backend
 |
 v
NestJS API
 |
 v
React Dashboard
```

### Kết quả
Có thể demo nhiều VM và theo dõi CPU, RAM, Disk, Network, uptime trực tiếp trên React dashboard.

**Đây là milestone demo đầu tiên của dự án.**

---

## Phase 3 — Alerting & Incident Operations

**Mục tiêu:** chuyển hệ thống từ chỉ quan sát sang hỗ trợ vận hành.

### Phạm vi
- Alert rules.
- Threshold-based alerts.
- Severity.
- Notification.
- Acknowledge alert.
- Incident creation.
- Incident assignment.
- Incident timeline.
- Resolve/close incident.
- Liên kết alert với resource và incident.

### Luồng

```text
CPU > 90% for 5 minutes
          |
          v
        Alert
          |
          v
    Incident #001
```

### Kết quả
Người vận hành có thể phát hiện, tiếp nhận và theo dõi quá trình xử lý sự cố ngay trong React dashboard.

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
| **Operational MVP** | Phase 0 → 3 | Monitoring + alerts + incidents |
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
- Chỉ thêm Jev khi hệ thống đã có đủ metrics, alerts và incident context.

# FAPOMS Architecture

## 1. System Architecture
FAPOMS is built as a modular monolith using NestJS for the backend, React for the frontend, and a shared TypeScript package for canonical types and interfaces.

### Modules Map
- **AuthModule:** Direct JWT Passport authentication.
- **UserModule:** Role and permission validation.
- **ClientModule:** Profile and custom workflow configurations.
- **BranchModule & AssayerModule:** GIS coordinate and proximity planning powered by PostGIS.
- **AssignmentModule, SchedulingModule, DocumentModule, ValidationModule:** Operational workflow processing, OCR queues, and transaction-safe state changes.

---

## 2. Database Schema
FAPOMS runs on PostgreSQL with the PostGIS spatial extension. Core entities use UUID identifiers and enforce transaction safety during updates.

### Geometries
- `branches.geom` (geometry, Point, 4326)
- `assayers.geom` (geometry, Point, 4326)
Distance calculations use `ST_DistanceSphere` to calculate proximity metrics.

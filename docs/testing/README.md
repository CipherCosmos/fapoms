# FAPOMS Automated Verification Infrastructure Guide

This directory documents the Stage-3 automated testing infrastructure created to ensure no future pull request or feature addition can be merged without automated verification.

## 1. Automated Verification Infrastructure Components

- **Playwright E2E Suite**: `playwright.config.ts` and `tests/e2e/workflow.spec.ts`
- **k6 Performance Load Testing Suite**: `k6/scripts/load-test.js`
- **SQL Data Integrity Scripts**: `scripts/sql/verify_integrity.sql`
- **Docker Stack Orchestration**: `docker/docker-compose.yml`
- **GitHub Actions CI/CD Pipeline**: `.github/workflows/ci.yml`

## 2. Running Verification Commands

### Monorepo Build & Unit Testing
```bash
npm run build:shared && npm run build:backend && npm run build:frontend
npm run test --workspace=packages/backend
```

### Playwright E2E Tests
```bash
npx playwright test --config=playwright.config.ts
```

### k6 Performance Load Benchmarks
```bash
k6 run k6/scripts/load-test.js
```

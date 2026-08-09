/**
 * FAPOMS load test — models the real production traffic mix so you get a *measured* capacity ceiling
 * instead of a guess. Run with k6 (https://k6.io).
 *
 *   BASE_URL=https://staging.example.com \
 *   STAFF_USER=ops1 STAFF_PASS=... ASSAYER_USER=asy1 ASSAYER_PASS=... \
 *   k6 run scripts/load-test/fapoms-load.js
 *
 * Scale the load with:  -e STAFF_VUS=150 -e MOBILE_VUS=400
 *
 * The mix reflects the described operation: a few hundred internal staff working lists/dashboards
 * concurrently, and thousands of field assayers who are mostly idle but poll/sync intermittently.
 * Tune the numbers to your real peak, then watch where the first wall is (almost always the database).
 */
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const API = `${BASE}/api/v1`;
const STAFF_VUS = Number(__ENV.STAFF_VUS || 100);
const MOBILE_VUS = Number(__ENV.MOBILE_VUS || 300);

const staffLatency = new Trend('staff_page_latency', true);
const mobileLatency = new Trend('mobile_sync_latency', true);
const bizErrors = new Rate('business_errors');

export const options = {
  scenarios: {
    // Internal staff: dashboards, work queues, billing — read-heavy, steady concurrency.
    staff_browsing: {
      executor: 'ramping-vus',
      exec: 'staff',
      startVUs: 0,
      stages: [
        { duration: '1m', target: Math.ceil(STAFF_VUS / 2) },
        { duration: '2m', target: STAFF_VUS },
        { duration: '3m', target: STAFF_VUS }, // hold at peak
        { duration: '1m', target: 0 },
      ],
    },
    // Field assayers: intermittent poll/sync from mobile — many VUs, long think times.
    mobile_sync: {
      executor: 'ramping-vus',
      exec: 'mobile',
      startVUs: 0,
      stages: [
        { duration: '1m', target: Math.ceil(MOBILE_VUS / 2) },
        { duration: '2m', target: MOBILE_VUS },
        { duration: '3m', target: MOBILE_VUS },
        { duration: '1m', target: 0 },
      ],
    },
  },
  thresholds: {
    // Production SLOs — fail the run if the system can't hold them at this load.
    http_req_failed: ['rate<0.01'],            // <1% transport errors
    business_errors: ['rate<0.01'],            // <1% non-2xx business responses
    staff_page_latency: ['p(95)<800'],         // staff pages under 800ms at p95
    mobile_sync_latency: ['p(95)<1200'],       // mobile sync under 1.2s at p95 (field networks)
  },
};

function login(username, password) {
  const res = http.post(`${API}/auth/login`, JSON.stringify({ username, password }), {
    headers: { 'Content-Type': 'application/json' },
  });
  const token = res.json('data.accessToken') || res.json('accessToken');
  check(res, { 'login ok': () => !!token });
  return token;
}

export function setup() {
  return {
    staffToken: login(__ENV.STAFF_USER || 'ops1', __ENV.STAFF_PASS || 'changeme'),
    assayerToken: login(__ENV.ASSAYER_USER || 'asy1', __ENV.ASSAYER_PASS || 'changeme'),
  };
}

function authed(token) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

// One staff "session": the pages an operations/finance user actually opens in a work loop.
export function staff(data) {
  const h = authed(data.staffToken);
  group('staff', () => {
    const reqs = [
      ['GET', `${API}/system-dashboard/operations`],
      ['GET', `${API}/assignments?page=1&limit=25`],
      ['GET', `${API}/projects?page=1&limit=50`],
      ['GET', `${API}/documents/operations/overview`],
      ['GET', `${API}/billing-engine/dashboard`],
    ];
    for (const [method, url] of reqs) {
      const res = http.request(method, url, null, h);
      staffLatency.add(res.timings.duration);
      bizErrors.add(res.status >= 400);
      check(res, { 'staff 2xx': (r) => r.status >= 200 && r.status < 300 });
      sleep(Math.random() * 2 + 1); // 1–3s think time between screens
    }
  });
}

// One assayer "poll": what the mobile app fetches when it foregrounds / syncs.
export function mobile(data) {
  const h = authed(data.assayerToken);
  group('mobile', () => {
    const reqs = [
      `${API}/assignments/assayer/me`,
      `${API}/notifications?limit=20`,
      `${API}/notifications/unread-count`,
    ];
    for (const url of reqs) {
      const res = http.get(url, h);
      mobileLatency.add(res.timings.duration);
      bizErrors.add(res.status >= 400);
    }
  });
  sleep(Math.random() * 20 + 10); // assayers poll every 10–30s, not constantly
}

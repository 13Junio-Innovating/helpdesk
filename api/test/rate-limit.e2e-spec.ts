import { API, createTestApp, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ AUTH_RATE_LIMIT_EMAIL: 3, AUTH_RATE_LIMIT_IP: 6 });
});
afterAll(() => t.close());

describe('limite de tentativas em login', () => {
  it('por e-mail: a 4ª tentativa na mesma conta => 429', async () => {
    const send = () => t.http().post(`${API}/auth/login`).send({ email: 'alvo@demo.local', password: 'x' });
    for (let i = 0; i < 3; i++) expect((await send()).status).toBe(401);
    const r = await send();
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('too_many_requests');
  });

  it('por IP: variar o e-mail não escapa do limite por IP', async () => {
    // 4 tentativas já contadas no teste anterior para este IP
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await t.http().post(`${API}/auth/login`).send({ email: `outro${i}@demo.local`, password: 'x' })).status);
    }
    expect(statuses).toEqual([401, 401, 429]);
  });

  it('rotas comuns não usam o limite de auth', async () => {
    await t.http().get(`${API}/health`).expect(200);
  });
});

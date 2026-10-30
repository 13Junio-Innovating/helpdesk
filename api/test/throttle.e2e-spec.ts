import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

// limites baixos SÓ neste arquivo (o ConfigModule lê o env quando o AppModule é importado)
process.env['THROTTLE_AUTH_EMAIL_LIMIT'] = '3';
process.env['THROTTLE_AUTH_IP_LIMIT'] = '6';
const { createApp } = await import('./helpers.js');

describe('Rate limit de autenticação (e2e)', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());
  const attempt = (email: string) => http().post('/api/v1/auth/login').send({ email, password: 'errada' });

  beforeAll(async () => {
    app = await createApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('por e-mail: bloqueia a conta-alvo mesmo variando maiúsculas', async () => {
    for (const e of ['alvo@demo.local', 'ALVO@demo.local', ' alvo@DEMO.local']) await attempt(e).expect(401);
    const res = await attempt('alvo@demo.local').expect(429);
    expect(res.body).toEqual({ code: 'too_many_requests', message: expect.any(String) });
  });

  it('por IP: bloqueia ao variar e-mails', async () => {
    // já houve 4 tentativas deste IP no teste anterior; limite 6
    await attempt('a@demo.local').expect(401);
    await attempt('b@demo.local').expect(401);
    await attempt('c@demo.local').expect(429);
  });

  it('rotas comuns não usam o limite de autenticação', async () => {
    await http().get('/api/v1/health').expect(200);
    await http().get('/api/v1/auth/me').expect(401);
  });
});

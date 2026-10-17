import type { Express } from 'express';
import request from 'supertest';

export interface AgentWithCsrf {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
}

/**
 * Creates a supertest agent with a fresh CSRF token fetched from the server.
 * The agent persists cookies across requests (session + CSRF).
 */
export async function createAgent(app: Express): Promise<AgentWithCsrf> {
  const agent = request.agent(app);
  const res = await agent.get('/api/v1/health');
  const setCookies: string[] = Array.isArray(res.headers['set-cookie'])
    ? res.headers['set-cookie']
    : res.headers['set-cookie']
      ? [res.headers['set-cookie']]
      : [];
  const csrfCookie = setCookies.find((c) => c.startsWith('draftox_csrf='));
  if (!csrfCookie) {
    // Agent already had one stored; read via a second call is unnecessary in tests.
    throw new Error('Expected draftox_csrf cookie from the server');
  }
  const token = decodeURIComponent(csrfCookie.split(';')[0].split('=')[1]);
  return { agent, csrfToken: token };
}

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

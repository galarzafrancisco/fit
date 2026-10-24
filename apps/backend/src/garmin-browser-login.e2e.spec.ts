import { callTool, createTestApp, type TestApp } from './test-support/test-app';

describe('Garmin browser sign-in across pods', () => {
  let test: TestApp;

  beforeAll(async () => {
    test = await createTestApp();
  });
  afterAll(async () => {
    await test.close();
  });

  it('completes on a different process than the one that began it: the client registration travels in the cookie', async () => {
    const token = await test.token({ subject: 'garmin-owner-a' });
    const started = await callTool(test, token, 'connect_garmin');
    const link = new URL(started.data.connectUrl).searchParams.get('link')!;
    const first = await test.http.get('/connect/garmin').query({ link });
    expect(first.status).toBe(302);
    const authorize = new URL(first.headers.location);
    const clientId = authorize.searchParams.get('client_id')!;
    // The code is bound to the client that began the login, as at a real authorization server
    const code = test.taico.approve('garmin-owner-a', clientId);
    const registrations = test.taico.registrations.length;

    await test.restart(); // another pod: no in-memory client registration

    const callback = await test.http
      .get('/connect/garmin/auth')
      .set('Cookie', String(first.headers['set-cookie']).split(';')[0])
      .query({ code, state: authorize.searchParams.get('state')! });
    expect(callback.status).toBe(302);
    expect(String(callback.headers['set-cookie'])).toMatch(/fit_garmin_session=/);
    expect(test.taico.registrations.length).toBe(registrations); // no second registration
    expect(test.taico.tokenRequests.at(-1)!.get('client_id')).toBe(clientId);
  });
});

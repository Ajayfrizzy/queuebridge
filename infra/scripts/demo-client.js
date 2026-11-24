export function client(app) {
  let cookie = '';
  return async (path, payload, method = 'POST') => {
    const response = await app.inject({
      method,
      url: '/api/v1' + path,
      headers: { cookie, 'x-qb-csrf': '1' },
      payload,
    });
    if (response.statusCode >= 400)
      throw new Error(`Demo request ${path} returned ${response.statusCode}`);
    const session = response.cookies.find((c) => c.name === 'qb_session');
    if (session) cookie = 'qb_session=' + session.value;
    return response.statusCode === 204 ? null : response.json();
  };
}

/**
 * The viewer token a POST /api/activate response issued, taken from its
 * Set-Cookie header: the only place the relay sends it. The JSON body carries
 * the session id alone (see relay/src/api/activate.ts), so a test that wants
 * the token for a header or a hand-built Cookie reads it where a browser gets
 * it. Throws rather than returning undefined, so a missing cookie fails the
 * test at the join instead of as a 401 somewhere later.
 */
export function viewerTokenFrom(res: { headers: Record<string, unknown> }): string {
  const header = res.headers['set-cookie']
  const cookies = header === undefined ? [] : Array.isArray(header) ? header.map(String) : [String(header)]
  const cookie = cookies.find((c) => c.startsWith('viewer_token='))
  if (cookie === undefined) throw new Error('response set no viewer_token cookie')
  const end = cookie.indexOf(';')
  return decodeURIComponent(cookie.slice('viewer_token='.length, end === -1 ? undefined : end))
}

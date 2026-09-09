// Optional outbound HTTPS tunnel. No host port publishing or account required.
// Downloads the platform binary from Cloudflare's official GitHub release.
import { chmod, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
const root = join(import.meta.dir, '..')
const directory = join(root, '.tools')
await mkdir(directory, { recursive: true, mode: 0o700 })
const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : null
if (process.platform !== 'linux' || !arch) throw new Error('Install cloudflared for this platform manually.')
const binary = join(directory, 'cloudflared')
if (!await Bun.file(binary).exists()) {
  const release = '2026.8.3'
  const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${release}/cloudflared-linux-${arch}`, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)
  // Verify against the asset digest published in GitHub release metadata.
  const metadata = await fetch(`https://api.github.com/repos/cloudflare/cloudflared/releases/tags/${release}`, { signal: AbortSignal.timeout(30_000) })
  if (!metadata.ok) throw new Error('Cannot verify release metadata')
  const info = await metadata.json() as { assets: { name: string, digest?: string }[] }
  const expected = info.assets.find((a) => a.name === `cloudflared-linux-${arch}`)?.digest
  const bytes = await response.arrayBuffer()
  const actual = 'sha256:' + new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
  if (!expected || actual !== expected) throw new Error('Release digest verification failed')
  await Bun.write(binary + '.tmp', bytes, { mode: 0o700 })
  await chmod(binary + '.tmp', 0o700)
  await import('node:fs/promises').then((fs) => fs.rename(binary + '.tmp', binary))
}
// Minimal containers may lack a system CA bundle. Use runtime roots plus
// locally installed CA certificates, without disabling TLS verification.
import { rootCertificates } from "node:tls"
const certificates = [...rootCertificates]
for (const name of await readdir("/usr/local/share/ca-certificates").catch(() => [])) {
  if (name.endsWith(".crt")) certificates.push(await readFile(join("/usr/local/share/ca-certificates", name), "utf8"))
}
const caFile = join(directory, "ca-bundle.pem")
await Bun.write(caFile, certificates.join("\n"), { mode: 0o600 })
const child = Bun.spawn([binary, 'tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${process.env.WEB_PORT ?? 3000}`], {
  cwd: root, env: { ...process.env, SSL_CERT_FILE: process.env.SSL_CERT_FILE ?? caFile }, stdout: 'inherit', stderr: 'inherit',
})
process.on('SIGTERM', () => child.kill())
process.on('SIGINT', () => child.kill())
process.exitCode = await child.exited

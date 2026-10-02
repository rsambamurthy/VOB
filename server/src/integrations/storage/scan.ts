/**
 * Upload safety:
 *  1. sniff the real file type from its first bytes (the browser-supplied type can't be trusted)
 *  2. optional virus scan with ClamAV (clamd INSTREAM over TCP — no extra dependency)
 */
import net from 'node:net';

export type Sniffed = 'application/pdf' | 'image/png' | 'image/jpeg' | null;

export function sniffType(buf: Buffer): Sniffed {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

/** PDFs with JavaScript or auto-actions are a common malware carrier; we don't need either. */
export function pdfLooksActive(buf: Buffer) {
  const s = buf.toString('latin1');
  return /\/JavaScript|\/JS\s*[(<]|\/Launch|\/OpenAction\s*<<[^>]*\/JS/.test(s);
}

export async function clamScan(buf: Buffer, host: string, port: number, timeoutMs = 15_000): Promise<{ clean: boolean; signature?: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let reply = '';
    sock.setTimeout(timeoutMs, () => { sock.destroy(); reject(new Error('ClamAV timed out')); });
    sock.on('error', reject);
    sock.on('data', (d) => { reply += d.toString(); });
    sock.on('end', () => {
      const r = reply.replace(/\0/g, '').trim();
      if (/OK$/.test(r)) resolve({ clean: true });
      else if (/FOUND$/.test(r)) resolve({ clean: false, signature: r.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, '') });
      else reject(new Error(`ClamAV: ${r || 'no reply'}`));
    });
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      for (let o = 0; o < buf.length; o += 64 * 1024) {
        const chunk = buf.subarray(o, o + 64 * 1024);
        const len = Buffer.alloc(4); len.writeUInt32BE(chunk.length, 0);
        sock.write(len); sock.write(chunk);
      }
      sock.write(Buffer.alloc(4)); // zero-length chunk = end of stream
    });
  });
}

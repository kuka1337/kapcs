// Temporary diagnostic: does importing @vercel/blob kill an Edge function?
export const config = { runtime: 'edge' };
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client';
export default async function handler() {
  // Just prove the module imported and the function runs.
  const ok = typeof generateClientTokenFromReadWriteToken === 'function';
  return new Response(JSON.stringify({ ok }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}

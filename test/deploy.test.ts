import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Guards against uploading local secrets with `vercel --prod`: Vercel's
 * built-in ignore list covers .env.local but not .env, which the README tells
 * the owner to create for `npm run dev`.
 */
describe('deployment configuration', () => {
  it('.vercelignore excludes everything except the function sources', () => {
    expect(existsSync('.vercelignore')).toBe(true);
    const lines = readFileSync('.vercelignore', 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
    expect(lines[0]).toBe('/*');
    expect(lines).not.toContain('!.env');
    expect(lines).not.toContain('!test');
    for (const needed of ['!api', '!src', '!package.json', '!package-lock.json', '!tsconfig.json', '!vercel.json']) expect(lines).toContain(needed);
  });

  it('.gitignore excludes .env but keeps .env.example', () => {
    const lines = readFileSync('.gitignore', 'utf8').split(/\r?\n/).map((l) => l.trim());
    expect(lines).toContain('.env');
    expect(lines).toContain('!.env.example');
  });

  it('vercel.json routes /mcp to the function and bounds its duration', () => {
    const cfg = JSON.parse(readFileSync('vercel.json', 'utf8')) as { rewrites: { source: string; destination: string }[]; functions: Record<string, { maxDuration: number }> };
    expect(cfg.rewrites).toContainEqual({ source: '/mcp', destination: '/api/mcp' });
    expect(cfg.functions['api/mcp.ts']?.maxDuration).toBeGreaterThanOrEqual(45);
  });

  it('serves a public/ directory so the project root is never static output', () => {
    expect(existsSync('public/robots.txt')).toBe(true);
    expect(readFileSync('public/robots.txt', 'utf8')).toContain('Disallow: /');
  });

  it('.env.example contains no values for the secret variables', () => {
    const text = readFileSync('.env.example', 'utf8');
    expect(text).toMatch(/^SMOOBU_API_KEY=$/m);
    expect(text).toMatch(/^SMOOBU_API_SECRET=$/m);
    expect(text).toMatch(/^SMOOBU_CUSTOMER_ID=$/m);
  });
});

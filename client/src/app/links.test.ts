import { describe, expect, it } from 'vitest';

import { httpLink, isHttpLink } from './links';

describe('isHttpLink', () => {
  it.each([
    'https://discord.gg/abc123',
    'http://chat.example.org/room',
    'HTTPS://Example.org',
    'https://signal.group/#CjQKIA',
  ])('accepts the web link %j', (text) => {
    expect(isHttpLink(text)).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'mailto:someone@example.org',
    'ftp://example.org',
    '//example.org/relative',
    '/relative/path',
    'discord.gg/abc123',
    'https://',
    '',
    'not a link',
  ])('refuses %j', (text) => {
    expect(isHttpLink(text)).toBe(false);
  });
});

describe('httpLink', () => {
  it('returns the parsed href, so what renders is what was checked', () => {
    expect(httpLink(' https://Example.org/a b ')).toBe('https://example.org/a%20b');
  });

  it('returns null for a link it refuses', () => {
    expect(httpLink('javascript:alert(1)')).toBeNull();
  });
});

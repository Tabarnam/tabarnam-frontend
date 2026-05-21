import { describe, test, expect } from 'vitest';
import { decideTourMode } from './decideTourMode';

describe('decideTourMode — first-visit tour gate', () => {
  test('returns "home" on / when nothing seen and no progress', () => {
    expect(decideTourMode({ pathname: '/', search: '', seen: null, progress: null })).toBe('home');
  });

  test('returns null once the tour has been seen, regardless of path', () => {
    expect(decideTourMode({ pathname: '/', search: '', seen: '1', progress: null })).toBeNull();
    expect(
      decideTourMode({ pathname: '/results', search: '?tour=1', seen: '1', progress: null }),
    ).toBeNull();
  });

  test('returns null on routes other than / and /results', () => {
    for (const pathname of ['/about', '/privacy', '/how-it-works', '/admin', '/login']) {
      expect(decideTourMode({ pathname, search: '', seen: null, progress: null })).toBeNull();
    }
  });

  test('returns null on / when a handoff is mid-flight (progress set)', () => {
    expect(decideTourMode({ pathname: '/', search: '', seen: null, progress: 'results' })).toBeNull();
  });

  test('returns null on /results with neither progress nor ?tour=1', () => {
    expect(
      decideTourMode({ pathname: '/results', search: '?q=coffee', seen: null, progress: null }),
    ).toBeNull();
  });

  test('returns "results" on /results when a handoff is in progress', () => {
    expect(
      decideTourMode({ pathname: '/results', search: '', seen: null, progress: 'results' }),
    ).toBe('results');
  });

  test('returns "results" on /results via an explicit ?tour=1 deep link', () => {
    expect(
      decideTourMode({
        pathname: '/results',
        search: '?q=organic+soap&country=US&tour=1',
        seen: null,
        progress: null,
      }),
    ).toBe('results');
  });

  test('seen flag overrides an explicit ?tour=1 deep link', () => {
    expect(
      decideTourMode({ pathname: '/results', search: '?tour=1', seen: '1', progress: null }),
    ).toBeNull();
  });

  test('tolerates an undefined search string', () => {
    expect(
      decideTourMode({ pathname: '/results', search: undefined, seen: null, progress: 'results' }),
    ).toBe('results');
    expect(
      decideTourMode({ pathname: '/results', search: undefined, seen: null, progress: null }),
    ).toBeNull();
  });
});

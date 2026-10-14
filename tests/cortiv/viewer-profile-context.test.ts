import { expect, it } from 'vitest';
import { viewerProfileContext } from '../../bots/cortiv/persona/viewer-profile-context.ts';

it('selects recent dated passages without promoting their first-person claims or dumping undated private text', () => {
  const text = viewerProfileContext('Old introduction\nUNDATED_PRIVATE\n\n- 2026-10-12 Player said: I have bread. ref #10\n- 2026-10-14 Recent claim #12\n- 2026-10-09 OLDEST\n- 2026-10-13 Next claim #11\n');
  expect(text).toContain('Old introduction');
  expect(text).toContain('L5：- 2026-10-14 Recent claim #12');
  expect(text).toContain('Next claim #11');
  expect(text).not.toContain('OLDEST');
  expect(text).not.toContain('UNDATED_PRIVATE');
  expect(text).not.toContain('I have bread');
  expect(text).toContain('未重新核验');
});
it('bounds long notes and supports dated headings with multiline provenance', () => {
  const text = viewerProfileContext('intro\n## 2026-10-14\nPlayer said: I have bread.\nSource: chat #10\n\n## unrelated\nPRIVATE\n- 2026-10-13 ' + 'x'.repeat(6000));
  expect(text).toContain('Player said: I have bread.\nSource: chat #10');
  expect(text).not.toContain('PRIVATE');
  expect(text).toContain('节选');
  expect(text.length).toBeLessThan(1500);
  expect(viewerProfileContext(null)).toBe('');
});

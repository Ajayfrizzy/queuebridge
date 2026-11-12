import { describe, expect, it } from 'vitest';
import type { ServicePolicy } from '@queuebridge/contracts';
import { describePolicy, enabledClasses, isSingleQueue } from './policy.js';

const p = (priority_order: ServicePolicy['priority_order'], grace = 300): ServicePolicy => ({
  version: 'v1',
  priority_order,
  grace_window_seconds: grace,
  override_reasons: ['accessibility_need'],
  transfer_placement: 'by_original_join_time',
});

describe('service policy display', () => {
  it('shows a single FIFO queue when only the normal class exists', () => {
    const text = describePolicy(p(['normal']));
    expect(text).toContain('Single queue');
    expect(text).not.toMatch(/urgent/i);
    expect(text).not.toContain('Enabled classes');
    expect(isSingleQueue(p(['normal']))).toBe(true);
  });

  it('lists only the classes that are enabled, in stored rank order', () => {
    expect(enabledClasses(p(['urgent', 'normal']))).toEqual(['Urgent', 'Normal']);
    expect(enabledClasses(p(['priority', 'normal']))).toEqual(['Priority', 'Normal']);
    expect(enabledClasses(p(['urgent', 'priority', 'normal']))).toEqual([
      'Urgent',
      'Priority',
      'Normal',
    ]);
  });

  it('never mentions a class that is not enabled', () => {
    const urgentOnly = describePolicy(p(['urgent', 'normal']));
    expect(urgentOnly).toContain('Urgent, Normal');
    expect(urgentOnly).not.toContain('Priority');
    const priorityOnly = describePolicy(p(['priority', 'normal']));
    expect(priorityOnly).toContain('Priority, Normal');
    expect(priorityOnly).not.toContain('Urgent');
  });

  it('uses the same published wording as the server, including transfer placement', () => {
    expect(describePolicy(p(['normal']))).toContain('keep their original waiting time');
    expect(
      describePolicy({ ...p(['priority', 'normal']), transfer_placement: 'end_of_queue' }),
    ).toContain('Only a supervisor can change');
  });

  it('includes the grace window', () => {
    expect(describePolicy(p(['normal'], 90))).toContain('Grace window 90s');
  });
});

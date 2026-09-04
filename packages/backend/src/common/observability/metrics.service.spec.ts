import { MetricsService } from './metrics.service';

describe('MetricsService (P2A-receptionist-v2)', () => {
  function make() {
    const m = new MetricsService();
    return m;
  }

  it('renders a counter with no increments as the help+type only', () => {
    const m = make();
    m.counter('vrm_test_total', 'A test counter');
    const text = m.render();
    expect(text).toContain('# HELP vrm_test_total A test counter');
    expect(text).toContain('# TYPE vrm_test_total counter');
    expect(text).not.toContain('vrm_test_total{'); // no rows yet
  });

  it('renders increments with sorted label keys', () => {
    const m = make();
    const c = m.counter('vrm_test_total', 'A test counter');
    c.inc({ tenant: 't1', status: 'ok' });
    c.inc({ tenant: 't1', status: 'ok' });
    c.inc({ tenant: 't2', status: 'ok' });
    c.inc({ tenant: 't1', status: 'fail' });
    const text = m.render();
    // t1+ok -> 2, t2+ok -> 1, t1+fail -> 1
    expect(text).toMatch(/vrm_test_total\{status="ok",tenant="t1"\} 2/);
    expect(text).toMatch(/vrm_test_total\{status="ok",tenant="t2"\} 1/);
    expect(text).toMatch(/vrm_test_total\{status="fail",tenant="t1"\} 1/);
  });

  it('escape backslash, double-quote, newline in label values', () => {
    const m = make();
    const c = m.counter('vrm_x_total', 'x');
    c.inc({ name: 'a"b\\c\nd' });
    const text = m.render();
    expect(text).toContain('name="a\\"b\\\\c\\nd"');
  });

  it('reset() clears all counter values', () => {
    const m = make();
    const c = m.counter('vrm_reset_total', 'x');
    c.inc({ k: 'v1' });
    c.inc({ k: 'v1' });
    expect(m.render()).toMatch(/vrm_reset_total\{k="v1"\} 2/);
    m.reset();
    expect(m.render()).not.toMatch(/vrm_reset_total\{/);
  });

  it('multiple counters produce one HELP+TYPE block each', () => {
    const m = make();
    m.counter('vrm_a_total', 'A').inc({});
    m.counter('vrm_b_total', 'B').inc({});
    const text = m.render();
    expect(text.match(/# HELP/g)?.length).toBe(2);
    expect(text).toContain('# TYPE vrm_a_total counter');
    expect(text).toContain('# TYPE vrm_b_total counter');
  });
});

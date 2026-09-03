import { expect } from 'chai';
import { LazyObservable } from '../src/dynamic-info';

describe('LazyObservable', () => {
  it('does not collect or expose data when disabled', async () => {
    let calls = 0;
    const values: number[] = [];
    const observable = new LazyObservable(
      'Disabled measurement',
      false,
      true,
      1,
      5,
      async () => {
        calls += 1;
        return 42;
      },
    );

    const subscription = observable.subscribe((value) => values.push(value));
    expect(await observable.getCurrentValue()).to.equal(undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).to.equal(0);
    expect(values).to.deep.equal([]);
    subscription.unsubscribe();
  });
});

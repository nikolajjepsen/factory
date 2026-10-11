import { describe, expect, it } from 'vitest';
import { EventQueue } from './eventQueue.js';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

describe('EventQueue', () => {
  it('yields items pushed before and after iteration starts, until closed', async () => {
    const queue = new EventQueue<number>();
    queue.push(1);
    const result = collect(queue);
    queue.push(2);
    await Promise.resolve();
    queue.push(3);
    queue.close();
    queue.push(4);
    expect(await result).toEqual([1, 2, 3]);
  });

  it('ends at once when closed while empty', async () => {
    const queue = new EventQueue<number>();
    queue.close();
    expect(await collect(queue)).toEqual([]);
  });
});

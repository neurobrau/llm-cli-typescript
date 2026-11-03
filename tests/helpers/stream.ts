import type { StreamEvent } from "../../src/domain/generation.js";

/** The event of an iterator result, or `undefined` once the iterator is done. */
export function eventOf(result: IteratorResult<StreamEvent>): StreamEvent | undefined {
  return result.done === true ? undefined : result.value;
}

export async function nextEvent(iterator: AsyncIterator<StreamEvent>): Promise<StreamEvent | undefined> {
  return eventOf(await iterator.next());
}

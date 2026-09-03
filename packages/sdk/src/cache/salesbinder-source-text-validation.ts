const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

export function hasUnpairedUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END) {
      if (index + 1 >= value.length) return true;
      const nextCode = value.charCodeAt(index + 1);
      if (nextCode < LOW_SURROGATE_START || nextCode > LOW_SURROGATE_END) return true;
      index++;
    } else if (code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END) {
      return true;
    }
  }
  return false;
}

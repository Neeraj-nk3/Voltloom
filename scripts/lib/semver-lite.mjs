// Just enough of semver for this project's "engines" range: "^x.y.z", ">=x.y.z", exact versions, joined with "||".
// (Pulling in the real semver package for one comparison would be a new dependency.)

/** Does `version` (e.g. "v24.12.0") satisfy the range? An unrecognised range part never matches. */
export function satisfies(version, range) {
  const here = version.replace(/^v/, '').split('.').map(Number);
  const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
  return range.split('||').some((part) => {
    const m = /^(\^|>=)?\s*v?(\d+)\.(\d+)\.(\d+)$/.exec(part.trim());
    if (!m) return false;
    const base = [Number(m[2]), Number(m[3]), Number(m[4])];
    if (m[1] === '^') return here[0] === base[0] && cmp(here, base) >= 0;
    if (m[1] === '>=') return cmp(here, base) >= 0;
    return cmp(here, base) === 0;
  });
}

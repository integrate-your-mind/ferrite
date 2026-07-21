import { isAbsolute, relative, sep } from "node:path";

const nativePath = { isAbsolute, relative, sep };

export function isPathInsideRoot(root, file, path = nativePath) {
  const rootRelative = path.relative(root, file);
  return (
    rootRelative.length > 0
    && rootRelative !== ".."
    && !rootRelative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(rootRelative)
  );
}

export function portableCanonicalPath(file) {
  const portable = file.replaceAll("\\", "/");
  const extendedUncPrefix = "//?/UNC/";
  if (portable.slice(0, extendedUncPrefix.length).toUpperCase() === extendedUncPrefix) {
    return `//${portable.slice(extendedUncPrefix.length)}`;
  }
  if (portable.startsWith("//?/")) {
    return portable.slice(4);
  }
  return portable;
}

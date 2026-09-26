/** Nested view of a skill directory. Paths are slash-separated and relative to the skill root. */

export interface SkillFileEntry {
  name: string;
  path: string;
}

export interface SkillDirNode {
  name: string;
  path: string;
  dirs: SkillDirNode[];
  files: SkillFileEntry[];
}

export function skillFileTree(files: readonly string[]): SkillDirNode {
  const root: SkillDirNode = { name: '', path: '', dirs: [], files: [] };
  for (const raw of files) {
    const parts = raw.split('/').filter((part) => part.length > 0);
    if (parts.length === 0) continue;
    let node = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index];
      const path = parts.slice(0, index + 1).join('/');
      let child = node.dirs.find((dir) => dir.name === name);
      if (!child) {
        child = { name, path, dirs: [], files: [] };
        node.dirs.push(child);
      }
      node = child;
    }
    const name = parts[parts.length - 1];
    if (!node.files.some((file) => file.path === raw)) {
      node.files.push({ name, path: raw });
    }
  }
  sortDir(root);
  return root;
}

/** Every directory path in the tree, used to start the browser collapsed. */
export function skillDirPaths(node: SkillDirNode): string[] {
  const paths: string[] = [];
  for (const dir of node.dirs) {
    paths.push(dir.path);
    paths.push(...skillDirPaths(dir));
  }
  return paths;
}

function sortDir(node: SkillDirNode) {
  node.dirs.sort((a, b) => a.name.localeCompare(b.name));
  node.files.sort((a, b) => a.name.localeCompare(b.name));
  for (const dir of node.dirs) sortDir(dir);
}

import { Injectable } from "@nestjs/common";
import { IndexerHttpClient } from "./indexer-http.client";

const SUMMARY_MAX_NODES = 8;
const IMPORTERS_MAX_NODES = 10;

/**
 * Builds the graph-summary context block for `architecture` questions (top
 * folders, most-depended-upon files) and the importers block for `change`
 * questions — both pulled from indexer's already-built Stage 7 graphs, since
 * chunks contain code, not relationships (LLM_PROMPTING.md "Graph summary
 * block"). Every call degrades to an empty/absent block on failure rather
 * than failing the chat turn — a missing graph summary is a worse answer,
 * not a broken one.
 */
@Injectable()
export class GraphSummaryService {
  constructor(private readonly indexer: IndexerHttpClient) {}

  async buildArchitectureSummary(repoId: string): Promise<string | null> {
    const [folders, dependencies] = await Promise.all([
      this.indexer.getFolders(repoId, { maxNodes: SUMMARY_MAX_NODES }).catch(() => null),
      this.indexer.getDependencies(repoId, { maxNodes: SUMMARY_MAX_NODES, includeExternal: false }).catch(() => null),
    ]);

    const sections: string[] = [];

    const folderPaths = folders?.nodes.filter((n) => n.type === "directory").map((n) => n.path ?? n.label) ?? [];
    if (folderPaths.length > 0) {
      sections.push(["STRUCTURE (top-level):", ...folderPaths.map((p) => `  ${p}`)].join("\n"));
    }

    const filePaths = dependencies?.nodes.filter((n) => n.type === "file").map((n) => n.path ?? n.label) ?? [];
    if (filePaths.length > 0) {
      sections.push(["MOST DEPENDED UPON:", ...filePaths.map((p) => `  ${p}`)].join("\n"));
    }

    return sections.length > 0 ? sections.join("\n\n") : null;
  }

  async buildImportersSummary(repoId: string, targetPath: string): Promise<string | null> {
    const search = await this.indexer.searchGraph(repoId, { q: targetPath, types: ["dependency"] }).catch(() => null);
    const match = search?.results.find((r) => r.node.path === targetPath) ?? search?.results[0];
    if (!match) return null;

    const neighbors = await this.indexer
      .getNeighbors(repoId, match.node.id, { direction: "in", maxNodes: IMPORTERS_MAX_NODES })
      .catch(() => null);
    const importers = neighbors?.nodes.filter((n) => n.id !== match.node.id).map((n) => n.path ?? n.label) ?? [];
    if (importers.length === 0) return null;

    return `DIRECT IMPORTERS OF ${targetPath}:\n  ${importers.join(", ")}`;
  }
}

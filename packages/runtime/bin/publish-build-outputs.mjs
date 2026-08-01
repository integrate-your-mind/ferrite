import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { isPathInsideRoot } from "./project-path.mjs";

export async function publishBuildOutputs(
  stagingOutDir,
  finalOutDir,
  outputs,
  { renameFile = rename, removeDirectory = rm } = {},
) {
  const publishRoot = await realpath(await mkdtemp(join(finalOutDir, ".ferrite-publish-")));
  const publications = [];
  let operationError;
  let preservePublishRoot = false;
  try {
    for (const [index, output] of outputs.entries()) {
      const source = resolve(stagingOutDir, output);
      const destination = resolve(finalOutDir, output);
      if (!isPathInsideRoot(stagingOutDir, source) || !isPathInsideRoot(finalOutDir, destination)) {
        throw new Error(`Ferrite client output escapes its build directory: ${output}`);
      }

      const sourceInfo = await lstat(source);
      const canonicalSource = await realpath(source);
      if (!sourceInfo.isFile() || canonicalSource !== source) {
        throw new Error(`Ferrite staged client output is not a regular file: ${output}`);
      }

      await mkdir(dirname(destination), { recursive: true });
      const canonicalDestinationParent = await realpath(dirname(destination));
      if (
        canonicalDestinationParent !== dirname(destination)
        || (
          canonicalDestinationParent !== finalOutDir
          && !isPathInsideRoot(finalOutDir, canonicalDestinationParent)
        )
      ) {
        throw new Error(`Ferrite client output directory escapes or aliases its build directory: ${output}`);
      }

      let hadDestination = false;
      try {
        const destinationInfo = await lstat(destination);
        if (!destinationInfo.isFile()) {
          throw new Error(`Ferrite client output destination is not a regular file: ${output}`);
        }
        hadDestination = true;
      } catch (error) {
        if (!error || typeof error !== "object" || error.code !== "ENOENT") {
          throw error;
        }
      }

      const pendingDestination = join(publishRoot, `${index}-${basename(output)}`);
      await copyFile(source, pendingDestination, constants.COPYFILE_EXCL);
      publications.push({
        destination,
        pendingDestination,
        backupDestination: join(publishRoot, `${index}-${basename(output)}.previous`),
        hadDestination,
        backedUp: false,
        published: false,
      });
    }

    try {
      for (const publication of publications) {
        if (publication.hadDestination) {
          await renameFile(publication.destination, publication.backupDestination);
          publication.backedUp = true;
        }
        await renameFile(publication.pendingDestination, publication.destination);
        publication.published = true;
      }
    } catch (publishError) {
      const rollbackErrors = await rollbackPublishedOutputs(publications, renameFile);
      if (rollbackErrors.length > 0) {
        preservePublishRoot = true;
        throw new AggregateError(
          [publishError, ...rollbackErrors],
          `Ferrite client output publication failed and could not be fully rolled back; recovery files are preserved at ${publishRoot}.`,
        );
      }
      throw publishError;
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (!preservePublishRoot) {
      try {
        await removeDirectory(publishRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        preservePublishRoot = true;
        if (operationError) {
          throw new AggregateError(
            [operationError, cleanupError],
            `Ferrite client output publication failed and scratch is preserved at ${publishRoot} because cleanup also failed.`,
          );
        }
        throw new Error(
          `Ferrite client output publication completed, but scratch is preserved at ${publishRoot} because cleanup failed.`,
          { cause: cleanupError },
        );
      }
    }
  }
}

async function rollbackPublishedOutputs(publications, renameFile) {
  const errors = [];
  for (let index = publications.length - 1; index >= 0; index -= 1) {
    const publication = publications[index];
    try {
      if (publication.published) {
        await rm(publication.destination, { force: true });
      }
      if (publication.backedUp) {
        await renameFile(publication.backupDestination, publication.destination);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

// synckit worker: resolves oxfmt options for the file (discovery + loading, which
// is async) and runs oxfmt's async formatter synchronously for the rule.
//
// oxlint runs JS plugins on a worker thread and requires `context.report` to be
// called synchronously during traversal, while config loading and oxfmt's
// `format()` are async (and shelling out to the oxfmt CLI from the plugin worker
// fails with ENOMEM). synckit runs this worker on its own thread and blocks the
// caller via Atomics until the formatted result is ready.

import { format } from 'oxfmt';
import { runAsWorker } from 'synckit';
import { resolveOptions, type ResolveArgs } from './config.js';

runAsWorker(async (fileName: string, source: string, args: ResolveArgs): Promise<string> => {
  const options = await resolveOptions(fileName, args);
  const { code, errors } = await format(fileName, source, options);
  // If oxfmt couldn't parse the file, leave it untouched — oxlint's own parser
  // reports the syntax error and we avoid a spurious "not formatted".
  if (errors?.some((error) => error.severity === 'Error')) return source;
  return code;
});

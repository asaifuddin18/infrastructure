/**
 * Lambda entry point for the Arena ingestion starter.
 *
 * The implementation lives in the application repository and arrives here as a published
 * package, so the analysis code stays next to the web app and MCP server that will share
 * it rather than being split across two repositories. This file exists only to give
 * `NodejsFunction` something local to bundle.
 */
export { handler } from '@asaifuddin18/arena-ingest-starter';

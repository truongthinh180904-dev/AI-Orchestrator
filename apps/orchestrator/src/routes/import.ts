import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ImportService } from '../services/import-service.js';
import { ImportRequestSchema } from '../types.js';

export interface ImportRoutesOptions {
  importService: ImportService;
}

export const importRoutes: FastifyPluginAsync<ImportRoutesOptions> = async (fastify, opts) => {
  const { importService } = opts;

  const handleImport = async (request: FastifyRequest) => {
    if (request.isMultipart()) {
      let buffer: Buffer | undefined;
      let filename: string | undefined;
      let dryRun: boolean | undefined;
      let mode: 'dry-run' | 'commit' | undefined;
      let filePath: string | undefined;

      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          buffer = await part.toBuffer();
          filename = part.filename;
        } else {
          const fieldName = part.fieldname;
          const value = typeof part.value === 'string' ? part.value : String(part.value);
          if (fieldName === 'dryRun') {
            dryRun = value === 'true' || value === '1';
          } else if (fieldName === 'mode') {
            if (value === 'dry-run' || value === 'commit') {
              mode = value;
            }
          } else if (fieldName === 'filePath') {
            filePath = value;
          }
        }
      }

      const result = await importService.execute({
        buffer,
        filename,
        dryRun,
        mode,
        filePath,
      });

      return { data: result };
    }

    const body = ImportRequestSchema.parse(request.body ?? {});
    const result = await importService.execute(body);
    return { data: result };
  };

  fastify.post('/import', handleImport);
  fastify.post('/api/import', handleImport);
};

import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async () => {
    return {
      data: {
        status: 'ok',
        timestamp: new Date().toISOString(),
      },
    };
  });

  fastify.get('/api/health', async () => {
    return {
      data: {
        status: 'ok',
        timestamp: new Date().toISOString(),
      },
    };
  });
};

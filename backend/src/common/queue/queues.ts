import { Queue } from 'bullmq';
import { redisConnection } from '../redis/redis';

// Define queues according to requirements Section 17
export const contentGenerationQueue = new Queue('content-generation-queue', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 60000, // Lần 1: 1p, các lần sau tăng dần
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

export const mediaProcessingQueue = new Queue('media-processing-queue', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 60000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

export const postSchedulingQueue = new Queue('post-scheduling-queue', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 60000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

export const facebookPublishingQueue = new Queue('facebook-publishing-queue', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 60000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

export const notificationQueue = new Queue('notification-queue', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 60000,
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});
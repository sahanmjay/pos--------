/**
 * RAMIS Unified Queue Manager
 * ────────────────────────────
 * High-performance background queue for Sri Lanka IRD RAMIS Invoice Submission.
 * Provides:
 *  1. Zero-config Embedded Asynchronous Worker with retries & exponential backoff
 *  2. Full BullMQ + Redis integration if USE_BULLMQ=true and Redis is configured
 *  3. Resilient disk journal log
 */

const fs = require('fs');
const path = require('path');
const RamisService = require('./ramis-service');

// Store journal in a clean hidden file or data folder to avoid root clutter
const JOURNAL_DIR = process.env.NEXPOS_DATA_DIR || path.join(__dirname, '.data');
const JOURNAL_PATH = path.join(JOURNAL_DIR, 'ramis_queue.json');

class EmbeddedRamisQueue {
  constructor() {
    this.ramisService = new RamisService();
    this.queue = [];
    this.processing = false;
    this.completed = [];
    this.failed = [];
    this.loadJournal();

    // Background processing loop
    setInterval(() => this.processNext(), 1500);
  }

  loadJournal() {
    try {
      if (fs.existsSync(JOURNAL_PATH)) {
        const raw = fs.readFileSync(JOURNAL_PATH, 'utf8');
        const data = JSON.parse(raw);
        this.queue = data.queue || [];
        this.completed = (data.completed || []).slice(-100);
        this.failed = (data.failed || []).slice(-100);
      }
    } catch (e) {
      this.queue = [];
    }
  }

  saveJournal() {
    try {
      if (!fs.existsSync(JOURNAL_DIR)) {
        fs.mkdirSync(JOURNAL_DIR, { recursive: true });
      }
      const data = {
        updatedAt: new Date().toISOString(),
        queue: this.queue,
        completed: this.completed.slice(-100),
        failed: this.failed.slice(-100)
      };
      fs.writeFileSync(JOURNAL_PATH, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {}
  }

  /**
   * Fast Enqueue (< 2ms)
   * Main checkout thread returns immediately
   */
  async enqueue(invoicePayload) {
    const job = {
      id: `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      data: invoicePayload,
      attemptsMade: 0,
      maxAttempts: 5,
      nextAttemptAt: Date.now(),
      status: 'pending',
      enqueuedAt: new Date().toISOString(),
      lastError: null
    };

    this.queue.push(job);
    this.saveJournal();

    console.log(`⚡ [RAMIS Queue] Enqueued invoice ${invoicePayload.taxInvoiceNo} (Job ID: ${job.id})`);
    setImmediate(() => this.processNext());

    return {
      success: true,
      jobId: job.id,
      queueSize: this.queue.length,
      status: 'enqueued'
    };
  }

  async processNext() {
    if (this.processing || this.queue.length === 0) return;

    const now = Date.now();
    const jobIndex = this.queue.findIndex(j => j.nextAttemptAt <= now);
    if (jobIndex === -1) return;

    const job = this.queue.splice(jobIndex, 1)[0];
    this.processing = true;

    try {
      job.attemptsMade += 1;
      job.status = 'processing';
      console.log(`⏳ [RAMIS Worker] Submitting ${job.data.taxInvoiceNo} to Schedule 1 (Attempt ${job.attemptsMade}/${job.maxAttempts})...`);

      const result = await this.ramisService.submitSchedule1(job.data);

      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      job.result = result;
      this.completed.push(job);
      console.log(`✅ [RAMIS Worker] ${job.data.taxInvoiceNo} ACCEPTED: ${result.ramisReference}`);

    } catch (err) {
      job.lastError = err.message;
      console.error(`❌ [RAMIS Worker] Job ${job.id} failed: ${err.message}`);

      if (job.attemptsMade < job.maxAttempts) {
        const delayMs = Math.min(3000 * Math.pow(2, job.attemptsMade - 1), 60000);
        job.nextAttemptAt = Date.now() + delayMs;
        job.status = 'retrying';
        this.queue.push(job);
      } else {
        job.status = 'failed';
        job.failedAt = new Date().toISOString();
        this.failed.push(job);
      }
    } finally {
      this.processing = false;
      this.saveJournal();
      if (this.queue.some(j => j.nextAttemptAt <= Date.now())) {
        setImmediate(() => this.processNext());
      }
    }
  }

  getStats() {
    return {
      pending: this.queue.length,
      completed: this.completed.length,
      failed: this.failed.length,
      recentCompleted: this.completed.slice(-5),
      recentFailed: this.failed.slice(-5)
    };
  }
}

/**
 * BullMQ Redis Queue Implementation
 */
class BullRamisQueue {
  constructor() {
    const { Queue, Worker } = require('bullmq');
    this.ramisService = new RamisService();
    const redis = {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: null
    };

    this.queue = new Queue('ramis-schedule1-invoices', {
      connection: redis,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: 1000,
        removeOnFail: 5000
      }
    });

    this.worker = new Worker('ramis-schedule1-invoices', async (job) => {
      return await this.ramisService.submitSchedule1(job.data);
    }, {
      connection: redis,
      concurrency: 5,
      limiter: { max: 10, duration: 1000 }
    });
  }

  async enqueue(payload) {
    const job = await this.queue.add('submit_schedule1', payload, {
      jobId: `ramis_${payload.taxInvoiceNo}_${Date.now()}`
    });
    return { success: true, jobId: job.id, status: 'enqueued' };
  }
}

// Singleton
let queueInstance = null;

function getQueue() {
  if (!queueInstance) {
    if (process.env.USE_BULLMQ === 'true') {
      try {
        queueInstance = new BullRamisQueue();
        console.log('🚀 [RAMIS Queue] Initialized with BullMQ Redis backend.');
        return queueInstance;
      } catch (e) {
        console.warn('⚠️ [RAMIS Queue] BullMQ unavailable, using embedded worker:', e.message);
      }
    }
    queueInstance = new EmbeddedRamisQueue();
    console.log('🚀 [RAMIS Queue] Initialized with Resilient Background Worker.');
  }
  return queueInstance;
}

module.exports = {
  getQueue,
  EmbeddedRamisQueue
};

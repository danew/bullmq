import { createHash } from 'crypto';
import { JobsOptions, RepeatBaseOptions, RepeatOptions } from '../interfaces';
import { CronStrategy } from '../types';
import { Crons } from './crons';
import { QueueBase } from './queue-base';
import { Job } from './job';
import { RedisConnection } from './redis-connection';

export class Repeat extends QueueBase {
  private cronStrategies: Record<string, CronStrategy>;
  constructor(
    name: string,
    opts?: RepeatBaseOptions,
    Connection?: typeof RedisConnection,
  ) {
    super(name, opts, Connection);

    this.cronStrategies = opts.settings && opts.settings.cronStrategies;
  }

  async addNextRepeatableJob<T = any, R = any, N extends string = string>(
    name: N,
    data: T,
    opts: JobsOptions,
    skipCheckExists?: boolean,
  ) {
    const repeatOpts = { ...opts.repeat };
    const prevMillis = opts.prevMillis || 0;
    const currentCount = repeatOpts.count ? repeatOpts.count + 1 : 1;

    if (
      typeof repeatOpts.limit !== 'undefined' &&
      currentCount > repeatOpts.limit
    ) {
      return;
    }

    let now = Date.now();

    if (
      !(typeof repeatOpts.endDate === undefined) &&
      now > new Date(repeatOpts.endDate).getTime()
    ) {
      return;
    }

    now = prevMillis < now ? now : prevMillis;

    const nextMillis = await Crons.calculate(
      repeatOpts,
      this.cronStrategies,
      now,
    );

    const hasImmediately =
      (repeatOpts.every || repeatOpts.cron) && repeatOpts.immediately;
    const offset = hasImmediately ? now - nextMillis : undefined;
    if (nextMillis) {
      // We store the undecorated opts.jobId into the repeat options
      if (!prevMillis && opts.jobId) {
        repeatOpts.jobId = opts.jobId;
      }

      const repeatJobKey = getRepeatKey(name, repeatOpts);

      let repeatableExists = true;

      if (!skipCheckExists) {
        // Check that the repeatable job hasn't been removed
        // TODO: a lua script would be better here
        const client = await this.client;
        repeatableExists = !!(await client.zscore(
          this.keys.repeat,
          repeatJobKey,
        ));
      }
      const { immediately, ...filteredRepeatOpts } = repeatOpts;

      // The job could have been deleted since this check
      if (repeatableExists) {
        return this.createNextJob<T, R, N>(
          name,
          nextMillis,
          repeatJobKey,
          { ...opts, repeat: { offset, ...filteredRepeatOpts } },
          data,
          currentCount,
          hasImmediately,
        );
      }
    }
  }

  private async createNextJob<T = any, R = any, N extends string = string>(
    name: N,
    nextMillis: number,
    repeatJobKey: string,
    opts: JobsOptions,
    data: T,
    currentCount: number,
    hasImmediately: boolean,
  ) {
    const client = await this.client;

    //
    // Generate unique job id for this iteration.
    //
    const jobId = getRepeatJobId(
      name,
      nextMillis,
      md5(repeatJobKey),
      opts.repeat.jobId,
    );
    const now = Date.now();
    const delay =
      nextMillis + (opts.repeat.offset ? opts.repeat.offset : 0) - now;

    const mergedOpts = {
      ...opts,
      jobId,
      delay: delay < 0 || hasImmediately ? 0 : delay,
      timestamp: now,
      prevMillis: nextMillis,
    };

    mergedOpts.repeat = { ...opts.repeat, count: currentCount };

    await client.zadd(this.keys.repeat, nextMillis.toString(), repeatJobKey);

    return this.Job.create<T, R, N>(this, name, data, mergedOpts);
  }

  async removeRepeatable(
    name: string,
    repeat: RepeatOptions,
    jobId?: string,
  ): Promise<number> {
    const repeatJobKey = getRepeatKey(name, { ...repeat, jobId });
    const repeatJobId = getRepeatJobId(
      name,
      '',
      md5(repeatJobKey),
      jobId || repeat.jobId,
    );

    return this.scripts.removeRepeatable(repeatJobId, repeatJobKey);
  }

  async removeRepeatableByKey(repeatJobKey: string): Promise<number> {
    const data = this.keyToData(repeatJobKey);

    const repeatJobId = getRepeatJobId(
      data.name,
      '',
      md5(repeatJobKey),
      data.id,
    );

    return this.scripts.removeRepeatable(repeatJobId, repeatJobKey);
  }

  private keyToData(key: string) {
    const data = key.split(':');
    const cron = data.slice(4).join(':') || null;

    return {
      key,
      name: data[0],
      id: data[1] || null,
      endDate: parseInt(data[2]) || null,
      tz: data[3] || null,
      cron,
    };
  }

  async getRepeatableJobs(start = 0, end = -1, asc = false) {
    const client = await this.client;

    const key = this.keys.repeat;
    const result = asc
      ? await client.zrange(key, start, end, 'WITHSCORES')
      : await client.zrevrange(key, start, end, 'WITHSCORES');

    const jobs = [];
    for (let i = 0; i < result.length; i += 2) {
      const data = result[i].split(':');
      jobs.push({
        key: result[i],
        name: data[0],
        id: data[1] || null,
        endDate: parseInt(data[2]) || null,
        tz: data[3] || null,
        cron: data[4],
        next: parseInt(result[i + 1]),
      });
    }
    return jobs;
  }

  async getRepeatableCount(): Promise<number> {
    const client = await this.client;
    return client.zcard(this.toKey('repeat'));
  }
}

function getRepeatJobId(
  name: string,
  nextMillis: number | string,
  namespace: string,
  jobId?: string,
) {
  const checksum = md5(`${name}${jobId || ''}${namespace}`);
  return `repeat:${checksum}:${nextMillis}`;
  // return `repeat:${jobId || ''}:${name}:${namespace}:${nextMillis}`;
  //return `repeat:${name}:${namespace}:${nextMillis}`;
}

function getRepeatKey(name: string, repeat: RepeatOptions) {
  const endDate = repeat.endDate ? new Date(repeat.endDate).getTime() : '';
  const tz = repeat.tz || '';
  const suffix = (repeat.cron ? repeat.cron : String(repeat.every)) || '';
  const jobId = repeat.jobId ? repeat.jobId : '';

  return `${name}:${jobId}:${endDate}:${tz}:${suffix}`;
}

function md5(str: string) {
  return createHash('md5').update(str).digest('hex');
}

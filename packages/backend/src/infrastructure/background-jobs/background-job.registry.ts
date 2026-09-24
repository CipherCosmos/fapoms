import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { BackgroundJobKind } from '@fapoms/shared';
import type { BackgroundJobDefinition } from './background-jobs.contract';

/**
 * Which kinds this process knows how to run, and how.
 *
 * Every feature registers its kinds here from its own module's `onModuleInit`, so the foundation
 * imports no feature and no feature has to edit the foundation to add a kind. Both process roles
 * (api and worker) build the same module graph, so both hold the same registry: the API reads a
 * definition's `start` and `prepare`, the worker its `run`.
 *
 * Registering a kind twice is refused loudly. Two definitions for one kind would mean whichever
 * module happened to initialise last decided how every such job runs.
 */
@Injectable()
export class BackgroundJobRegistry {
  private readonly logger = new Logger(BackgroundJobRegistry.name);
  private readonly definitions = new Map<string, BackgroundJobDefinition<any>>();

  register<P = Record<string, unknown>>(definition: BackgroundJobDefinition<P>): void {
    if (this.definitions.has(definition.kind)) {
      throw new Error(`Background job kind "${definition.kind}" is registered twice.`);
    }
    this.definitions.set(definition.kind, definition as BackgroundJobDefinition<any>);
    this.logger.log(`Registered background job kind ${definition.kind}.`);
  }

  get(kind: string): BackgroundJobDefinition<any> | undefined {
    return this.definitions.get(kind);
  }

  /** The definition, or a 400 a person can read — a kind with no handler must never be queued. */
  require(kind: string): BackgroundJobDefinition<any> {
    const definition = this.definitions.get(kind);
    if (!definition) {
      throw new BadRequestException(`"${kind}" is not a kind of work this server can do in the background.`);
    }
    return definition;
  }

  kinds(): BackgroundJobKind[] {
    return [...this.definitions.keys()] as BackgroundJobKind[];
  }
}

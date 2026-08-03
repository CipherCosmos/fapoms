import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ValidationQueryEntity } from './validation-query.entity';
import { ValidationQueryMessageEntity, QueryMessageAuthor } from './validation-query-message.entity';
import { ValidationQueryStatus } from '@fapoms/shared';

export interface PostMessageDto {
  body?: string;
  attachments?: { url: string; fileName: string; fileType: string }[];
  pageNumber?: number;
  region?: { x: number; y: number; w: number; h: number };
  snapshotPath?: string;
}

/**
 * The clarification conversation between the data entry desk and the assayer.
 *
 * Kept apart from ValidationQueryService, which owns the query's *lifecycle*
 * (open → responded → resolved). This owns the exchange inside it.
 */
@Injectable()
export class QueryThreadService {
  constructor(
    @InjectRepository(ValidationQueryEntity)
    private readonly queryRepository: Repository<ValidationQueryEntity>,
    @InjectRepository(ValidationQueryMessageEntity)
    private readonly messageRepository: Repository<ValidationQueryMessageEntity>,
  ) {}

  async listMessages(queryId: string): Promise<ValidationQueryMessageEntity[]> {
    await this.mustExist(queryId);
    return this.messageRepository.find({
      where: { validationQueryId: queryId },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Appends a message and moves the query's status to match who spoke: an assayer
   * reply marks it RESPONDED, a desk follow-up re-opens it. A resolved thread is
   * closed — reopening is a deliberate act, not a side effect of typing.
   */
  async postMessage(
    queryId: string,
    authorType: QueryMessageAuthor,
    authorId: string,
    authorName: string | null,
    dto: PostMessageDto,
  ): Promise<ValidationQueryMessageEntity> {
    const query = await this.mustExist(queryId);

    if (query.status === ValidationQueryStatus.RESOLVED) {
      throw new ForbiddenException('This clarification is resolved. Reopen it before adding to the thread.');
    }
    if (authorType === QueryMessageAuthor.ASSAYER && query.assayerId !== authorId) {
      throw new ForbiddenException('You may only reply to your own clarifications.');
    }
    if (!dto.body?.trim() && !dto.snapshotPath && !(dto.attachments ?? []).length) {
      throw new ForbiddenException('A message needs text, a snapshot, or an attachment.');
    }

    const message = this.messageRepository.create({
      validationQueryId: queryId,
      authorType,
      authorId,
      authorName,
      body: dto.body?.trim() || null,
      attachments: dto.attachments ?? null,
      pageNumber: dto.pageNumber ?? null,
      region: dto.region ?? null,
      snapshotPath: dto.snapshotPath ?? null,
      createdBy: authorId,
      updatedBy: authorId,
    });
    const saved = await this.messageRepository.save(message);

    query.lastMessageAt = saved.createdAt;
    // The desk points the assayer at a marked crop on the packet. That lives on the
    // *message* (snapshotPath), but the mobile chat reads attachments off the query —
    // so mirror the crop onto the query's attachment list, otherwise the assayer
    // never sees the image the desk is talking about.
    if (authorType === QueryMessageAuthor.STAFF && saved.snapshotPath) {
      const existing = Array.isArray(query.attachments) ? query.attachments : [];
      query.attachments = [
        ...existing,
        {
          url: saved.snapshotPath,
          fileName: saved.pageNumber ? `Marked area on page ${saved.pageNumber}` : 'Marked area',
          fileType: 'image/png',
          uploadedBy: 'VALIDATOR',
          timestamp: saved.createdAt?.toISOString?.() ?? new Date().toISOString(),
        },
      ];
    }
    if (authorType === QueryMessageAuthor.ASSAYER) {
      query.status = ValidationQueryStatus.RESPONDED;
      query.respondedAt = saved.createdAt;
      // Keep the legacy single-answer field aligned so older readers still work.
      if (saved.body) query.assayerResponse = saved.body;
    } else if (query.status === ValidationQueryStatus.RESPONDED) {
      query.status = ValidationQueryStatus.OPEN;
    }
    await this.queryRepository.save(query);

    return saved;
  }

  private async mustExist(queryId: string): Promise<ValidationQueryEntity> {
    const query = await this.queryRepository.findOne({ where: { id: queryId } });
    if (!query) throw new NotFoundException(`Clarification ${queryId} not found`);
    return query;
  }
}

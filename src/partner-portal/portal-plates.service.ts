import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { normalizePlate } from '../common/util/plate';
import { DatabaseService } from '../db/database.service';
import { partnerPlates } from '../db/schema';
import { CreatePlateDto } from './dto/create-plate.dto';

export interface PartnerPlate {
  id: number;
  plateNumber: string;
  plateNumberNorm: string;
  vehicleType: string | null;
}

/** CRUD for a partner's registered plates ("Daftarkan Plat"), row-scoped to partnerId. */
@Injectable()
export class PortalPlatesService {
  constructor(private readonly database: DatabaseService) {}

  async list(partnerId: number): Promise<PartnerPlate[]> {
    const rows = await this.database.db
      .select()
      .from(partnerPlates)
      .where(eq(partnerPlates.partnerId, partnerId))
      .orderBy(asc(partnerPlates.plateNumberNorm));
    return rows.map((r) => ({
      id: r.id,
      plateNumber: r.plateNumber,
      plateNumberNorm: r.plateNumberNorm,
      vehicleType: r.vehicleType,
    }));
  }

  /** Normalized plates for fleet scoping. Empty ⇒ the partner sees nothing. */
  async registeredNorms(partnerId: number): Promise<string[]> {
    const rows = await this.database.db
      .select({ norm: partnerPlates.plateNumberNorm })
      .from(partnerPlates)
      .where(eq(partnerPlates.partnerId, partnerId));
    return rows.map((r) => r.norm);
  }

  async create(partnerId: number, dto: CreatePlateDto): Promise<PartnerPlate> {
    const norm = normalizePlate(dto.plateNumber);
    if (!norm) throw new BadRequestException('Nomor plat tidak valid');

    const [row] = await this.database.db
      .insert(partnerPlates)
      .values({
        partnerId,
        plateNumber: dto.plateNumber.trim(),
        plateNumberNorm: norm,
        vehicleType: dto.vehicleType?.trim() || null,
      })
      .onConflictDoNothing({
        target: [partnerPlates.partnerId, partnerPlates.plateNumberNorm],
      })
      .returning();

    if (!row) throw new ConflictException('Plat sudah terdaftar');
    return {
      id: row.id,
      plateNumber: row.plateNumber,
      plateNumberNorm: row.plateNumberNorm,
      vehicleType: row.vehicleType,
    };
  }

  async remove(partnerId: number, id: number): Promise<{ deleted: true }> {
    const [row] = await this.database.db
      .delete(partnerPlates)
      .where(and(eq(partnerPlates.id, id), eq(partnerPlates.partnerId, partnerId)))
      .returning({ id: partnerPlates.id });
    if (!row) throw new NotFoundException('Plat tidak ditemukan');
    return { deleted: true };
  }
}

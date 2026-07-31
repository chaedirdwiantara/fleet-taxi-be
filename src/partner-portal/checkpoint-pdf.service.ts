import { Injectable } from '@nestjs/common';
import { createElement as h } from 'react';
import {
  CheckpointPointKey,
  CHECKPOINT_POINT_LABELS,
  HANDOVER_TYPE_LABELS,
  HandoverParty,
  HandoverType,
  handoverGiver,
  handoverPartyLabel,
} from './checkpoint.constants';
import { CheckpointDetail, CheckpointMediaView } from './portal-checkpoints.service';

const WIB_FMT = new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Jakarta',
  dateStyle: 'long',
  timeStyle: 'short',
});

function formatWib(iso: string | null): string {
  return iso ? `${WIB_FMT.format(new Date(iso))} WIB` : '-';
}

/**
 * Berita acara serah terima kendaraan — A4 portrait, per-point sections with
 * embedded photos and both parties' signatures. Media arrives as raw buffers
 * keyed by media id (read from storage by the checkpoints service).
 */
@Injectable()
export class CheckpointPdfService {
  async toPdf(
    partnerName: string,
    detail: CheckpointDetail,
    buffers: Map<number, Buffer>,
  ): Promise<Buffer> {
    // Imported lazily: @react-pdf/renderer is ESM-heavy and only needed here
    const { Document, Page, Text, View, Image, renderToBuffer } =
      await import('@react-pdf/renderer');

    const label = (text: string) => h(Text, { style: { fontSize: 8, color: '#666' } }, text);
    const value = (text: string) => h(Text, { style: { fontSize: 10 } }, text);
    const field = (l: string, v: string, flex = 1) =>
      h(View, { style: { flex, marginBottom: 6 } }, label(l), value(v));

    const img = (m: CheckpointMediaView, width: number, height: number) => {
      const buf = buffers.get(m.id);
      if (!buf) return null;
      return h(Image, {
        key: String(m.id),
        src: buf,
        style: { width, height, objectFit: 'cover', marginRight: 6, marginBottom: 6 },
      });
    };

    const pointSections = detail.points.map((p) =>
      h(
        View,
        { key: p.pointKey, wrap: false, style: { marginBottom: 10 } },
        h(
          View,
          { style: { flexDirection: 'row', alignItems: 'center', marginBottom: 3 } },
          h(
            Text,
            { style: { fontSize: 10, fontWeight: 700, flex: 1 } },
            CHECKPOINT_POINT_LABELS[p.pointKey as CheckpointPointKey] ?? p.pointKey,
          ),
          h(
            Text,
            {
              style: {
                fontSize: 9,
                fontWeight: 700,
                color: p.passed ? '#15803d' : p.passed === false ? '#b91c1c' : '#666',
              },
            },
            p.passed ? 'LULUS' : p.passed === false ? 'TIDAK LULUS' : 'TIDAK DINILAI',
          ),
        ),
        p.note ? h(Text, { style: { fontSize: 9, marginBottom: 3 } }, `Catatan: ${p.note}`) : null,
        h(
          View,
          { style: { flexDirection: 'row', flexWrap: 'wrap' } },
          ...p.media.filter((m) => m.status === 'uploaded').map((m) => img(m, 160, 110)),
        ),
        h(View, { style: { borderBottom: 0.5, borderColor: '#ddd', marginTop: 4 } }),
      ),
    );

    // Penyerah/penerima are derived from the handover direction: the partner's
    // own officer delivers, the counterpart returns.
    const giver = handoverGiver(detail.handoverType);
    const receiver: HandoverParty = giver === 'partner' ? 'counterpart' : 'partner';
    const partyLabel = (party: HandoverParty) => handoverPartyLabel(detail.handoverType, party);
    const partyName = (party: HandoverParty) =>
      (party === 'partner' ? detail.partnerStaffName : detail.counterpartName) ?? '-';

    const signature = (party: HandoverParty, role: string) => {
      const kind = party === 'partner' ? 'signature_partner' : 'signature_counterpart';
      const sig = detail.signatures.find((s) => s.kind === kind && s.status === 'uploaded');
      return h(
        View,
        { style: { flex: 1, alignItems: 'center' } },
        h(Text, { style: { fontSize: 9, fontWeight: 700 } }, role),
        h(Text, { style: { fontSize: 8, color: '#666', marginBottom: 4 } }, partyLabel(party)),
        sig && buffers.get(sig.id)
          ? h(Image, { src: buffers.get(sig.id)!, style: { width: 140, height: 70 } })
          : h(View, { style: { width: 140, height: 70, borderBottom: 0.5 } }),
        h(Text, { style: { fontSize: 9, marginTop: 4 } }, `( ${partyName(party)} )`),
      );
    };

    const doc = h(
      Document,
      null,
      h(
        Page,
        { size: 'A4', style: { padding: 32 } },
        h(
          Text,
          { style: { fontSize: 14, fontWeight: 700, marginBottom: 2 } },
          'Berita Acara Serah Terima Kendaraan',
        ),
        h(Text, { style: { fontSize: 10, color: '#666', marginBottom: 12 } }, partnerName),
        h(
          View,
          { style: { flexDirection: 'row' } },
          field('Nomor Plat', detail.plateNumber),
          field(
            'Jenis Serah Terima',
            HANDOVER_TYPE_LABELS[detail.handoverType as HandoverType] ?? detail.handoverType,
          ),
        ),
        h(
          View,
          { style: { flexDirection: 'row' } },
          field(`Penyerah (${partyLabel(giver)})`, partyName(giver)),
          field(`Penerima (${partyLabel(receiver)})`, partyName(receiver)),
          field(`Telepon ${partyLabel('counterpart')}`, detail.counterpartPhone ?? '-'),
        ),
        h(
          View,
          { style: { flexDirection: 'row' } },
          field(
            'Odometer',
            detail.odometerKm != null ? `${detail.odometerKm.toLocaleString('id-ID')} km` : '-',
          ),
          field('Baterai', detail.batteryPercent != null ? `${detail.batteryPercent}%` : '-'),
          field('Waktu Selesai', formatWib(detail.completedAt)),
        ),
        detail.generalNotes ? field('Catatan Umum', detail.generalNotes) : null,
        h(View, { style: { borderBottom: 1, marginVertical: 8 } }),
        ...pointSections,
        h(
          View,
          { wrap: false, style: { flexDirection: 'row', marginTop: 16 } },
          signature(giver, 'Penyerah'),
          signature(receiver, 'Penerima'),
        ),
      ),
    );

    return Buffer.from(await renderToBuffer(doc));
  }
}

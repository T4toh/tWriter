import { Component, HostListener, computed, inject, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BloqueTipo } from '../shared/note-blocks';
import { NoteFormService } from '../core/note-form-service';
import { SettingsService } from '../core/settings-service';
import { ModalService } from '../shared/modal-service';
import { Select, SelectOption } from '../shared/select';

@Component({
  selector: 'app-note-form-modal',
  imports: [FormsModule, Select],
  templateUrl: './note-form-modal.html',
  styleUrl: './note-form-modal.scss',
})
export class NoteFormModal {
  private svc = inject(NoteFormService);
  private settings = inject(SettingsService);
  private modal = inject(ModalService);

  private readonly plantillaSelect = viewChild<Select>('plantillaSelect');

  protected readonly editing = this.svc.editing;
  protected readonly creando = this.svc.creando;
  protected readonly plantillas = this.svc.plantillas;

  protected readonly plantillaOptions = computed<SelectOption[]>(() =>
    this.plantillas().map((t) => ({
      value: t.id,
      label: t.origen === 'archivo' ? `${t.label} · propia` : t.label,
    })),
  );

  protected readonly destino = computed(() => {
    const s = this.editing();
    const root = this.settings.root();
    if (!s) return '';
    if (root && s.parentDir.startsWith(root)) {
      const rel = s.parentDir.slice(root.length).replace(/^[/\\]/, '');
      return rel || '.';
    }
    return s.parentDir;
  });

  protected readonly puedeCrear = computed(() => {
    const s = this.editing();
    if (!s || this.creando()) return false;
    const n = s.nombre.trim();
    return n.length > 0 && !n.includes('/') && !n.includes('\\');
  });

  /** Backdrop, "Cancelar" y Escape pasan por acá: si hay algo escrito que se
   *  perdería, pide confirmación antes de tirarlo. */
  protected async close(): Promise<void> {
    if (
      this.svc.tieneContenido() &&
      !(await this.modal.confirm({
        title: 'Descartar nota',
        message: 'Se pierde lo que escribiste en los bloques. ¿Cerrar igual?',
        okLabel: 'Descartar',
        danger: true,
      }))
    ) {
      return;
    }
    this.svc.close();
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (!this.editing()) return;
    void this.close();
  }

  protected onNombre(v: string): void {
    this.svc.setNombre(v);
  }

  protected async onPlantilla(id: string): Promise<void> {
    const s = this.editing();
    if (this.svc.tieneContenido()) {
      const ok = await this.modal.confirm({
        title: 'Cambiar de plantilla',
        message: 'Se descarta lo que escribiste en los bloques. ¿Seguimos?',
        okLabel: 'Cambiar',
        danger: true,
      });
      if (!ok) {
        // El combo ya se movió de forma optimista (Select.pick actualiza su
        // propio signal antes de este await); como `s.plantillaId` no
        // cambió, Angular no vuelve a llamar `writeValue` solo, hay que
        // forzarlo para que el combo no quede mintiendo.
        if (s) this.plantillaSelect()?.writeValue(s.plantillaId);
        return;
      }
    }
    this.svc.aplicarPlantilla(id);
  }

  protected onTitulo(i: number, texto: string): void {
    this.svc.patchBloque(i, { texto });
  }

  protected onParrafo(i: number, texto: string): void {
    this.svc.patchBloque(i, { texto });
  }

  protected onItem(i: number, idx: number, valor: string): void {
    const s = this.editing();
    if (!s) return;
    const items = [...s.bloques[i].items];
    items[idx] = valor;
    // Un item vacío al final siempre disponible, así no hay que apretar "+".
    if (idx === items.length - 1 && valor.trim() !== '') items.push('');
    this.svc.patchBloque(i, { items });
  }

  protected quitarItem(i: number, idx: number): void {
    const s = this.editing();
    if (!s) return;
    const items = s.bloques[i].items.filter((_, k) => k !== idx);
    this.svc.patchBloque(i, { items: items.length > 0 ? items : [''] });
  }

  protected add(tipo: BloqueTipo): void {
    this.svc.addBloque(tipo);
  }

  protected quitar(i: number): void {
    this.svc.removeBloque(i);
  }

  protected mover(i: number, delta: -1 | 1): void {
    this.svc.moverBloque(i, delta);
  }

  /** El componente solo crea. Que la nota quede a la vista (descolapsar el pane,
   *  elegir la tab) lo sigue haciendo `createNoteIn`, que es donde ya funciona:
   *  `svc.open()` le devuelve el path creado. */
  protected async crear(): Promise<void> {
    await this.svc.crear();
  }

  protected async guardarPlantilla(): Promise<void> {
    const nombre = await this.modal.prompt({
      title: 'Guardar plantilla',
      message: 'Se guarda en Plantillas/ del repo de novelas, sin el contenido que escribiste.',
      placeholder: 'Ej: Nave',
      okLabel: 'Guardar',
      validate: (v) => {
        const t = v.trim();
        if (!t) return 'Nombre vacío';
        if (t.includes('/') || t.includes('\\')) return 'Sin barras / o \\';
        return null;
      },
    });
    if (!nombre?.trim()) return;
    const limpio = nombre.trim();
    const resultado = await this.svc.guardarPlantilla(limpio, false);
    if (resultado !== 'conflicto') return;
    const pisar = await this.modal.confirm({
      title: 'Ya existe',
      message: `Plantillas/${limpio}.md ya existe. ¿La sobrescribo?`,
      okLabel: 'Sobrescribir',
      danger: true,
    });
    if (pisar) await this.svc.guardarPlantilla(limpio, true);
  }
}

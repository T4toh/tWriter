import { Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BloqueTipo } from '../shared/note-blocks';
import { NoteFormService } from '../core/note-form-service';
import { SettingsService } from '../core/settings-service';
import { ModalService } from '../shared/modal-service';

@Component({
  selector: 'app-note-form-modal',
  imports: [FormsModule],
  templateUrl: './note-form-modal.html',
  styleUrl: './note-form-modal.scss',
})
export class NoteFormModal {
  private svc = inject(NoteFormService);
  private settings = inject(SettingsService);
  private modal = inject(ModalService);

  protected readonly editing = this.svc.editing;
  protected readonly creando = this.svc.creando;
  protected readonly plantillas = this.svc.plantillas;

  protected readonly destino = computed(() => {
    const s = this.editing();
    const root = this.settings.root();
    if (!s) return '';
    if (!root) return s.parentDir;
    return s.parentDir.startsWith(root) ? s.parentDir.slice(root.length + 1) : s.parentDir;
  });

  protected readonly puedeCrear = computed(() => {
    const s = this.editing();
    if (!s || this.creando()) return false;
    const n = s.nombre.trim();
    return n.length > 0 && !n.includes('/') && !n.includes('\\');
  });

  protected close(): void {
    this.svc.close();
  }

  protected onNombre(v: string): void {
    this.svc.setNombre(v);
  }

  protected async onPlantilla(id: string): Promise<void> {
    if (this.svc.tieneContenido()) {
      const ok = await this.modal.confirm({
        title: 'Cambiar de plantilla',
        message: 'Se descarta lo que escribiste en los bloques. ¿Seguimos?',
        okLabel: 'Cambiar',
        danger: true,
      });
      if (!ok) return;
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
}

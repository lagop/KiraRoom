import { Injectable } from '@nestjs/common';
import en from './locales/en.json';
import es from './locales/es.json';

type Language = 'en' | 'es';

@Injectable()
export class TranslationsService {
  private translations: Record<Language, Record<string, any>> = { en, es };

  translate(language: Language, key: string, params?: Record<string, string | number>): string {
    const keys = key.split('.');
    let value: any = this.translations[language] ?? this.translations.es;

    for (const k of keys) {
      value = value?.[k];
      if (value === undefined) break;
    }

    if (typeof value !== 'string') {
      return key;
    }

    if (params) {
      return value.replace(/\{(\w+)\}/g, (_, param) => String(params[param] ?? `{${param}}`));
    }

    return value;
  }

  getTranslations(language: Language): Record<string, any> {
    return this.translations[language] ?? this.translations.es;
  }

  getSupportedLanguages(): string[] {
    return Object.keys(this.translations);
  }
}

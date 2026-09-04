"use client";

import { Settings as SettingsIcon, Key, ArrowRight } from "lucide-react";
import Link from "next/link";

export default function SaasSettingsPage() {
  const sections = [
    {
      href: "/saas/settings/platform-llm",
      icon: Key,
      title: "Proveedor de IA del chatbot",
      description:
        "Configura el modelo y la API key del Asistente Virtual para todos los salones.",
      badge: "Haiku · Sonnet",
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 truncate">
            Platform Settings
          </h1>
          <p className="text-gray-500 mt-1">
            Configuración global de la plataforma
          </p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
        {sections.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="flex items-center gap-4 p-5 hover:bg-gray-50 transition-colors group"
          >
            <div className="p-3 bg-slate-100 rounded-lg group-hover:bg-slate-200">
              <s.icon className="w-6 h-6 text-slate-800" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-gray-900">{s.title}</h3>
                {s.badge && (
                  <span className="text-xs px-2 py-0.5 bg-purple-100 text-purple-700 rounded">
                    {s.badge}
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-500 mt-0.5">{s.description}</p>
            </div>
            <ArrowRight className="w-5 h-5 text-gray-400 group-hover:text-gray-600" />
          </Link>
        ))}
      </div>

      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 text-sm text-gray-600 flex items-start gap-2">
        <SettingsIcon className="w-4 h-4 mt-0.5" />
        <div>
          Las secciones adicionales (facturación global, dominios,
          integraciones) aparecerán aquí cuando estén disponibles.
        </div>
      </div>
    </div>
  );
}
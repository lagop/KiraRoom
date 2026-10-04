import { Store } from "lucide-react";

/**
 * A salon that does not exist answers 404, not a 200 page saying so: a
 * search engine should drop the URL, not index "salon not found".
 */
export default function SalonNotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-purple-50 via-white to-pink-50 px-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-lg p-8 text-center">
        <div className="mx-auto w-16 h-16 bg-purple-100 rounded-full flex items-center justify-center mb-4">
          <Store className="w-8 h-8 text-purple-600" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Salón no encontrado</h1>
        <p className="text-gray-600">
          No existe ningún salón en esta dirección. Revisa el enlace que te han enviado.
        </p>
      </div>
    </div>
  );
}

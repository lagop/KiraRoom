'use client'

import { useState, useEffect } from 'react'
import { apiClient } from '@/lib/api'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { toast } from '@/components/ui/use-toast'

/**
 * The products the till sells and their stock (owner and managers). Prices
 * come back from the API as Decimal strings ("12.50"): always read them with
 * Number() -- `price.toFixed` on a string crashed this page.
 */
interface Product {
  id: string
  name: string
  description?: string
  sku?: string
  price: number | string
  costPrice?: number | string | null
  quantity: number
  lowStockAlert: number
  category?: string
  isActive: boolean
  imageUrl?: string
}

interface ProductCategory {
  id: string
  name: string
  description?: string
}

const euros = (value: number | string | null | undefined) =>
  Number(value ?? 0).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Inténtalo de nuevo.')

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<ProductCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('')
  const [showLowStock, setShowLowStock] = useState(false)
  const [saving, setSaving] = useState(false)
  // The product about to be deleted, confirmed in the panel's dialog.
  const [pendingDelete, setPendingDelete] = useState<Product | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      setLoading(true)
      const [productsData, categoriesData] = await Promise.all([
        apiClient.getProducts(),
        apiClient.getProductCategories(),
      ])
      setProducts(productsData)
      setCategories(categoriesData)
    } catch (error) {
      toast({ title: 'No se pudieron cargar los productos', description: errorText(error), variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  const handleSearch = async () => {
    try {
      setLoading(true)
      const data = await apiClient.getProducts({
        search: searchTerm,
        category: selectedCategory || undefined,
        lowStock: showLowStock,
      })
      setProducts(data)
    } catch (error) {
      toast({ title: 'No se pudo buscar', description: errorText(error), variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const productData = {
      name: formData.get('name'),
      description: formData.get('description') || undefined,
      sku: formData.get('sku') || undefined,
      price: parseFloat(formData.get('price') as string),
      costPrice: formData.get('costPrice') ? parseFloat(formData.get('costPrice') as string) : undefined,
      // On an edit, a new quantity is logged as a stock count (the difference).
      quantity: parseInt(formData.get('quantity') as string, 10),
      lowStockAlert: parseInt(formData.get('lowStockAlert') as string, 10) || 5,
      category: formData.get('category') || undefined,
      trackInventory: true,
      isActive: true,
    }

    setSaving(true)
    try {
      if (editingProduct) {
        await apiClient.updateProduct(editingProduct.id, productData)
        toast({ title: 'Producto guardado' })
      } else {
        await apiClient.createProduct(productData)
        toast({ title: 'Producto creado' })
      }
      setShowModal(false)
      setEditingProduct(null)
      loadData()
    } catch (error) {
      toast({ title: 'No se pudo guardar el producto', description: errorText(error), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const performDelete = async () => {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      const result = (await apiClient.deleteProduct(pendingDelete.id)) as unknown as { deactivated?: boolean } | undefined
      toast(
        result?.deactivated
          ? {
              title: 'Producto desactivado',
              description: 'Tiene ventas o movimientos de stock: se ha retirado de la caja y su historial se conserva.',
            }
          : { title: 'Producto eliminado' },
      )
      loadData()
    } catch (error) {
      toast({ title: 'No se pudo eliminar el producto', description: errorText(error), variant: 'destructive' })
    } finally {
      setDeleting(false)
      setPendingDelete(null)
    }
  }

  const filteredProducts = products.filter(p => {
    if (showLowStock && p.quantity > p.lowStockAlert) return false
    return true
  })

  return (
    <div className="p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center mb-6">
        <h1 className="text-2xl font-bold">Productos y stock</h1>
        <button
          onClick={() => {
            setEditingProduct(null)
            setShowModal(true)
          }}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
        >
          Añadir producto
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow p-4 mb-6">
        <div className="flex flex-wrap gap-4">
          <input
            type="text"
            placeholder="Buscar productos…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="border rounded-lg px-4 py-2 flex-1 min-w-[200px]"
          />
          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            className="border rounded-lg px-4 py-2"
          >
            <option value="">Todas las categorías</option>
            {categories.map(cat => (
              <option key={cat.id} value={cat.name}>{cat.name}</option>
            ))}
          </select>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showLowStock}
              onChange={(e) => setShowLowStock(e.target.checked)}
              className="rounded"
            />
            Solo con poco stock
          </label>
          <button
            onClick={handleSearch}
            className="bg-gray-800 text-white px-4 py-2 rounded-lg hover:bg-gray-900"
          >
            Buscar
          </button>
        </div>
      </div>

      {/* Products Table */}
      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-semibold">Producto</th>
              <th className="px-4 py-3 text-left text-sm font-semibold">Referencia</th>
              <th className="px-4 py-3 text-left text-sm font-semibold">Categoría</th>
              <th className="px-4 py-3 text-right text-sm font-semibold">Precio</th>
              <th className="px-4 py-3 text-right text-sm font-semibold">Stock</th>
              <th className="px-4 py-3 text-center text-sm font-semibold">Estado</th>
              <th className="px-4 py-3 text-center text-sm font-semibold">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                  Cargando…
                </td>
              </tr>
            ) : filteredProducts.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                  No hay productos
                </td>
              </tr>
            ) : (
              filteredProducts.map(product => (
                <tr key={product.id} className="border-t hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="font-medium">{product.name}</div>
                    {product.description && (
                      <div className="text-sm text-gray-500 truncate max-w-xs">
                        {product.description}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm">{product.sku || '-'}</td>
                  <td className="px-4 py-3 text-sm">{product.category || '-'}</td>
                  <td className="px-4 py-3 text-right">{euros(product.price)}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={product.quantity <= product.lowStockAlert ? 'text-red-600 font-medium' : ''}>
                      {product.quantity}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-2 py-1 rounded-full text-xs ${
                      product.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                    }`}>
                      {product.isActive ? 'A la venta' : 'Desactivado'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center whitespace-nowrap">
                    <button
                      onClick={() => {
                        setEditingProduct(product)
                        setShowModal(true)
                      }}
                      className="text-blue-600 hover:text-blue-800 mr-3"
                    >
                      Editar
                    </button>
                    <button
                      onClick={() => setPendingDelete(product)}
                      className="text-red-600 hover:text-red-800"
                    >
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 w-full max-w-md max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-4">
              {editingProduct ? 'Editar producto' : 'Añadir producto'}
            </h2>
            <form onSubmit={handleSave}>
              <div className="space-y-4">
                <div>
                  <label htmlFor="product-name" className="block text-sm font-medium mb-1">Nombre *</label>
                  <input
                    id="product-name"
                    name="name"
                    required
                    defaultValue={editingProduct?.name}
                    className="w-full border rounded-lg px-3 py-2"
                  />
                </div>
                <div>
                  <label htmlFor="product-description" className="block text-sm font-medium mb-1">Descripción</label>
                  <textarea
                    id="product-description"
                    name="description"
                    defaultValue={editingProduct?.description || ''}
                    className="w-full border rounded-lg px-3 py-2"
                    rows={3}
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="product-sku" className="block text-sm font-medium mb-1">Referencia</label>
                    <input
                      id="product-sku"
                      name="sku"
                      defaultValue={editingProduct?.sku || ''}
                      className="w-full border rounded-lg px-3 py-2"
                    />
                  </div>
                  <div>
                    <label htmlFor="product-category" className="block text-sm font-medium mb-1">Categoría</label>
                    <input
                      id="product-category"
                      name="category"
                      defaultValue={editingProduct?.category || ''}
                      className="w-full border rounded-lg px-3 py-2"
                      list="categories"
                    />
                    <datalist id="categories">
                      {categories.map(cat => (
                        <option key={cat.id} value={cat.name} />
                      ))}
                    </datalist>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="product-price" className="block text-sm font-medium mb-1">Precio (€) *</label>
                    <input
                      id="product-price"
                      name="price"
                      type="number"
                      step="0.01"
                      min="0"
                      required
                      defaultValue={editingProduct ? Number(editingProduct.price) : ''}
                      className="w-full border rounded-lg px-3 py-2"
                    />
                    <p className="mt-1 text-xs text-gray-500">Como los precios de tus servicios (con o sin IVA, según tu ajuste).</p>
                  </div>
                  <div>
                    <label htmlFor="product-cost" className="block text-sm font-medium mb-1">Precio de coste (€)</label>
                    <input
                      id="product-cost"
                      name="costPrice"
                      type="number"
                      step="0.01"
                      min="0"
                      defaultValue={editingProduct?.costPrice != null ? Number(editingProduct.costPrice) : ''}
                      className="w-full border rounded-lg px-3 py-2"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="product-quantity" className="block text-sm font-medium mb-1">Unidades en stock *</label>
                    <input
                      id="product-quantity"
                      name="quantity"
                      type="number"
                      min="0"
                      required
                      defaultValue={editingProduct?.quantity ?? 0}
                      className="w-full border rounded-lg px-3 py-2"
                    />
                  </div>
                  <div>
                    <label htmlFor="product-low" className="block text-sm font-medium mb-1">Aviso de poco stock</label>
                    <input
                      id="product-low"
                      name="lowStockAlert"
                      type="number"
                      min="0"
                      defaultValue={editingProduct?.lowStockAlert ?? 5}
                      className="w-full border rounded-lg px-3 py-2"
                    />
                  </div>
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => {
                    setShowModal(false)
                    setEditingProduct(null)
                  }}
                  className="px-4 py-2 border rounded-lg hover:bg-gray-50"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-blue-300"
                >
                  {saving ? 'Guardando…' : editingProduct ? 'Guardar' : 'Crear'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title={`¿Eliminar el producto «${pendingDelete?.name ?? ''}»?`}
        description="Si ya se ha vendido o tiene movimientos de stock, se desactiva en lugar de borrarse: deja de salir en la caja y su historial se conserva."
        confirmLabel="Eliminar producto"
        destructive
        loading={deleting}
        onCancel={() => setPendingDelete(null)}
        onConfirm={performDelete}
      />
    </div>
  )
}

"use client";

import { useState } from "react";
import { X, LogIn } from "lucide-react";
import apiClient, { setToken } from "@/lib/api";
import { useToast } from "@/components/ui/use-toast";
import { useTranslations } from "@/lib/use-translation";

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoginSuccess: (user: any) => void;
}

export default function LoginModal({
  isOpen,
  onClose,
  onLoginSuccess,
}: LoginModalProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const t = useTranslations();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await apiClient.login(email, password);
      setToken(response.accessToken);

      // Fetch fresh client data from API to ensure we have the latest info
      let userData: any = response.user;
      if (response.user.id && response.user.role === "client") {
        try {
          const freshClientData = await apiClient.getClient(response.user.id);
          userData = {
            ...response.user,
            firstName: freshClientData.firstName,
            lastName: freshClientData.lastName,
            email: freshClientData.email || "",
            phone: freshClientData.phone || "",
          };
        } catch (error) {
          console.error(
            "Failed to fetch fresh client data after login:",
            error,
          );
          // Use response.user as fallback
        }
      }

      // Store user info in localStorage
      if (typeof window !== "undefined") {
        localStorage.setItem("user", JSON.stringify(userData));
      }

      toast({
        title: t("login.welcome_back"),
        description: t("login.sign_in_prompt"),
      });

      onLoginSuccess(userData);
      onClose();
    } catch (err) {
      // Handle login errors with user-friendly messages
      let errorMessage = "Login failed";

      if (err instanceof Error) {
        if (
          err.message.includes("401") ||
          err.message.includes("Unauthorized")
        ) {
          errorMessage = "Invalid email or password";
        } else if (err.message.includes("500")) {
          errorMessage = "Server error. Please try again later";
        } else {
          errorMessage = err.message;
        }
      }

      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full">
        <div className="flex items-center justify-between p-6 border-b">
          <h2 className="text-2xl font-bold text-gray-900">
            {t("login.login")}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="p-6">
          {error && (
            <div className="bg-red-50 text-red-600 p-4 rounded-lg mb-4">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t("login.email")}
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                required
                disabled={loading}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {t("login.password")}
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
                required
                disabled={loading}
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-purple-600 text-white py-2 px-4 rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50 flex items-center justify-center"
            >
              {loading ? (
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></div>
              ) : (
                <LogIn className="h-5 w-5 mr-2" />
              )}
              {loading ? t("login.logging_in") : t("login.login")}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

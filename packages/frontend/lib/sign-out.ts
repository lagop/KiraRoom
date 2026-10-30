import apiClient, { removeToken } from "./api";

/**
 * Ends the session (server and local tokens) and goes to the login page.
 * Shared by the sidebar and the header's account menu.
 */
export async function signOut(): Promise<void> {
  try {
    await apiClient.logout();
  } catch (error) {
    console.error("Error logging out:", error);
  } finally {
    removeToken();
    window.location.href = "/login";
  }
}

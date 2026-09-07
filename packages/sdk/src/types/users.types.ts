/** SalesBinder v2 users directory types. */

export interface SalesBinderUser {
  id: string;
  name?: string | null;
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  firstname?: string | null;
  lastname?: string | null;
}

export interface SalesBinderUsersListResponse {
  users?: SalesBinderUser[] | SalesBinderUser[][];
  pagination?: {
    count?: number | string;
    page?: number | string;
    pages?: number | string;
  };
  count?: number | string;
  page?: number | string;
  pages?: number | string;
}

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, Route, Switch } from "wouter";
import * as api from "./api";
import { Repos } from "./pages/Repos";
import { Review } from "./pages/Review";
import { Visual } from "./pages/Visual";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 15_000 },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Switch>
        <Route path="/" component={Repos} />
        <Route path="/review" component={Review} />
        <Route path="/visual" component={Visual} />
        <Route>
          <div className="mx-auto mt-24 w-full max-w-md rounded-md border border-edge bg-panel px-6 py-6 text-center">
            <p className="font-mono text-[13px] text-del">404</p>
            <p className="mt-1 text-[12px] text-mute">
              No such page.{" "}
              <Link href={api.href("/")} className="text-accent hover:underline">
                Repo list
              </Link>
            </p>
          </div>
        </Route>
      </Switch>
    </QueryClientProvider>
  );
}

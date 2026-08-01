import { Route, Switch } from "wouter";

export function App() {
  return (
    <Switch>
      <Route path="/">{() => <div>rev: repo list (todo)</div>}</Route>
      <Route path="/review">{() => <div>rev: review (todo)</div>}</Route>
    </Switch>
  );
}

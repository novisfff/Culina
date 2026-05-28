import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';

export function LoginScreen() {
  const { login, isLoading } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setError('');
      await login(username, password);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败');
    }
  }

  return (
    <main className="login-shell">
      <section className="login-card">
        <p className="eyebrow">Culina 家庭厨房</p>
        <h1>登录家庭厨房</h1>
        <p className="subtle">使用管理员配置或家庭成员账号登录。</p>
        <form className="form-grid" onSubmit={handleSubmit}>
          <label className="span-two">
            <span>用户名</span>
            <input className="text-input" value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label className="span-two">
            <span>密码</span>
            <input
              className="text-input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error && <p className="error-text span-two">{error}</p>}
          <button className="solid-button span-two" type="submit" disabled={isLoading}>
            {isLoading ? '登录中...' : '进入家庭厨房'}
          </button>
        </form>
      </section>
    </main>
  );
}

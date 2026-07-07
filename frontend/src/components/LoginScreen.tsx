import { useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';

export function AuthStatusScreen({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <main className="login-shell">
      <section className="login-card">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        <p className="subtle">{description}</p>
        {children}
      </section>
    </main>
  );
}

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
    <AuthStatusScreen
      eyebrow="Culina 家庭厨房"
      title="登录家庭厨房"
      description="使用管理员配置或家庭成员账号登录。"
    >
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
    </AuthStatusScreen>
  );
}


import React, { useState } from 'react';
import { Layout as AntLayout, Grid } from 'antd';
import { Routes, Route } from 'react-router-dom';

// 1. InstallationChecker를 import 합니다.
import InstallationChecker from './components/InstallationChecker';

import Sidebar   from './components/Sidebar';
import AppHeader from './components/AppHeader';
import EventDetail from './pages/EventDetail';
import EventEdit    from './pages/EventEdit';   // ← 이 줄

// 각 페이지 컴포넌트
import Dashboard          from './pages/Dashboard';
import EventCreate        from './pages/EventCreate';
import EventList          from './pages/EventList';

import PageView           from  './pages/PageView';
import Participation      from  './pages/Participation'
//유입환경
import InflowEnvironment from './pages/InflowEnvironment'

//모바일 메뉴 환경
import OverlayLayout from './components/OverLayout';

//리다이렉트 페이지
import Redirect from './pages/Redirect'
import Admin    from './pages/Admin';
import PrdData from './pages/PrdData';



const { Sider, Content } = AntLayout;
const { useBreakpoint } = Grid;

export default function App() {
  // ① 훅과 isMobile 계산은 컴포넌트 최상단에서
  const screens = useBreakpoint();
  const isMobile = !screens.md;

  // ② 모바일용 OverlayLayout vs 데스크탑용 AntLayout+Sidebar
  const [collapsed, setCollapsed] = useState(false);

  
  // ── 모바일: OverlayLayout ─────────────────────────────
  if (isMobile) {
    return (
      <InstallationChecker>
      <OverlayLayout>
        <Routes>
          <Route index element={<Dashboard />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="event/list" element={<EventList />} />
          <Route path="event/detail/:id" element={<EventDetail />} />
          <Route path="event/edit/:id" element={<EventEdit />} />
          <Route path="event/create" element={<EventCreate />} />
          <Route path="stats/pageview"     element={<PageView />} />
          <Route path="stats/participation" element={<Participation />} />
          <Route path="stats/environment" element={<InflowEnvironment />} />
          <Route path="redirect"  element={<Redirect />} />
          <Route path="stats/prddata"  element={<PrdData />} />
          <Route path="admin" element={<Admin    />} />
          <Route path="*" element={<Dashboard />} />
        </Routes>
        </OverlayLayout>
        </InstallationChecker>
    );
  }

  // ── 데스크탑: 고정형 Sider + AntLayout ───────────────────
  const SIDER_WIDTH      = 240;
  const COLLAPSED_WIDTH  = 80;

  return (
  <InstallationChecker>
    <AntLayout style={{ minHeight: '100vh' }}>
      <Sider
        breakpoint="md"
        collapsible
        collapsedWidth={COLLAPSED_WIDTH}
        collapsed={collapsed}
        onBreakpoint={broken => setCollapsed(broken)}
        onCollapse={setCollapsed}
        width={SIDER_WIDTH}
        style={{
          position: 'fixed',
          height: '100vh',
          left: 0,
          top: 0,
          bottom: 0,
          zIndex: 100,
        }}
      >
        <Sidebar
          collapsed={collapsed}
          onToggle={() => setCollapsed(prev => !prev)}
        />
      </Sider>
      <AntLayout
        style={{
          marginLeft: collapsed ? COLLAPSED_WIDTH : SIDER_WIDTH,
          transition: 'margin-left 0.2s ease',
        }}
      >
        <AppHeader
          isMobile={false}
          onMenuClick={() => setCollapsed(prev => !prev)}
        />
        <Content style={{ margin: 16, padding: 16 }}>
          <Routes>
            <Route index element={<Dashboard />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="event/list" element={<EventList />} />
            <Route path="event/detail/:id" element={<EventDetail />} />
            <Route path="event/edit/:id" element={<EventEdit />} />
            <Route path="event/create" element={<EventCreate />} />
            <Route path="stats/pageview"     element={<PageView />} />
            <Route path="stats/participation" element={<Participation />} />
            <Route path="stats/environment" element={<InflowEnvironment />} />
            <Route path="stats/environment" element={<InflowEnvironment />} />
            <Route path="redirect" element={<Redirect />} />
            <Route path="admin" element={<Admin    />} />
            <Route path="stats/prddata"  element={<PrdData />} />
            <Route path="*" element={<Dashboard />} />
          </Routes>
        </Content>
      </AntLayout>
      </AntLayout>
    </InstallationChecker>
  );
}

import DrissionPage
import DrissionPage
import json
import csv
import os
import time

# 创建浏览器实例
tab = DrissionPage.Chromium().latest_tab
# 请求 URL
find_job_url = "https://www.zhipin.com/wapi/zpgeek/pc/recommend/job/list.json?page=1&pageSize=15&city=101210100&experience=101,103,102,108,104&degree=202,203&scale=302,301&encryptExpectId=&mixExpectType=&expectInfo=&jobType=&salary=&industry=&_=1755215886995"

# 异常处理页面URL
exception_handle_url = "https://www.zhipin.com/web/geek/jobs?city=101210100&query=%E5%85%A8%E6%A0%88%E5%B7%A5%E7%A8%8B%E5%B8%88"

def get_job_list(find_job_url=find_job_url):
    tab.get(find_job_url)
    tab.wait(3)
    response_data = tab.json
    # print(response_data)
    return response_data

def build_job_list_url(page=1, pageSize=30):
    job_list_url = f"https://www.zhipin.com/wapi/zpgeek/pc/recommend/job/list.json?page={page}&pageSize={pageSize}&city=101210100&experience=101,103,102,108,104&degree=202,203&scale=302,301&encryptExpectId=&mixExpectType=&expectInfo=&jobType=&salary=&industry=&_=1755215886995"
    return job_list_url

def handle_access_anomaly():
    """
    处理访问行为异常：跳转到指定页面并刷新
    
    Returns:
        bool: 是否处理成功
    """
    try:
        print("检测到访问行为异常，正在自动处理...")
        print(f"跳转到异常处理页面: {exception_handle_url}")
        
        # 跳转到异常处理页面
        tab.get(exception_handle_url)
        tab.wait(3)
        
        print("页面跳转完成，正在刷新...")
        # 刷新页面
        tab.refresh()
        
        print("页面刷新完成，等待5秒...")
        # 等待5秒
        time.sleep(5)
        
        print("异常处理完成，继续爬取...")
        return True
        
    except Exception as e:
        print(f"处理访问异常时出错: {e}")
        return False

def get_pagination_info(json_data):
    """
    获取分页相关信息
    
    Args:
        json_data (dict): JSON响应数据
        
    Returns:
        dict: 包含分页信息的字典
    """
    try:
        if isinstance(json_data, str):
            json_data = json.loads(json_data)
        
        zp_data = json_data.get('zpData', {})
        
        pagination_info = {
            "hasMore": zp_data.get('hasMore', False),  # 是否还有更多页面
            "jobListCount": len(zp_data.get('jobList', [])),  # 当前页职位数量
        }
        
        return pagination_info
        
    except Exception as e:
        print(f"获取分页信息时出错: {e}")
        return None

def check_access_anomaly(json_data):
    """
    检查是否出现访问行为异常
    
    Args:
        json_data (dict): JSON响应数据
        
    Returns:
        bool: 是否出现异常
    """
    try:
        if isinstance(json_data, str):
            json_data = json.loads(json_data)
        
        # 检查code是否为37（访问行为异常）
        code = json_data.get('code', 0)
        message = json_data.get('message', '')
        
        if code == 37 and "访问行为异常" in message:
            print(f"检测到访问行为异常: {message}")
            return True
        
        return False
        
    except Exception as e:
        print(f"检查访问异常时出错: {e}")
        return False

def extract_job_data(json_data):
    """
    从JSON数据中提取并整理工作信息
    
    Args:
        json_data (dict): 工作列表JSON数据
        
    Returns:
        list: 整理好的工作信息列表，每个元素是一个字典
    """
    try:
        if isinstance(json_data, str):
            json_data = json.loads(json_data)
        
        zp_data = json_data.get('zpData', {})
        job_list = zp_data.get('jobList', [])
        
        if not job_list:
            print("未找到工作列表数据")
            return []
        
        organized_jobs = []
        
        for job in job_list:
            # 整理单个工作信息
            job_info = {
                # 职位基本信息
                "职位名称": job.get("jobName", ""),
                "薪资": job.get("salaryDesc", ""),
                "工作经验": job.get("jobExperience", ""),
                "学历要求": job.get("jobDegree", ""),
                "城市": job.get("cityName", ""),
                "职位标签": "|".join(job.get("jobLabels", [])),
                "技能要求": "|".join(job.get("skills", [])),
                "职位类型": job.get("jobType", ""),
                
                # 公司信息
                "公司名称": job.get("brandName", ""),
                "公司行业": job.get("brandIndustry", ""),
                "公司规模": job.get("brandScaleName", ""),
                "融资阶段": job.get("brandStageName", ""),
                "公司ID": job.get("encryptBrandId", ""),
                
                # BOSS信息
                "BOSS姓名": job.get("bossName", ""),
                "BOSS职位": job.get("bossTitle", ""),
                "BOSS在线": "是" if job.get("bossOnline", False) else "否",
                "BOSS认证": job.get("bossCert", ""),
                "BOSS ID": job.get("encryptBossId", ""),
                
                # 职位详情
                "职位ID": job.get("encryptJobId", ""),
                "安全ID": job.get("securityId", ""),
                "期望ID": job.get("expectId", ""),
                "列表ID": job.get("lid", ""),
                
                # 福利待遇
                "福利": "|".join(job.get("welfareList", [])),
                "每周工作天数": job.get("daysPerWeekDesc", ""),
                "最少工作月数": job.get("leastMonthDesc", ""),
                
                # 地理位置
                "区域": job.get("areaDistrict", ""),
                "商业区": job.get("businessDistrict", ""),
                "经度": job.get("gps", {}).get("longitude", ""),
                "纬度": job.get("gps", {}).get("latitude", ""),
                
                # 其他标识
                "是否匿名": "是" if job.get("anonymous", False) else "否",
                "是否外地": "是" if job.get("outland", False) else "否",
                "是否优选": "是" if job.get("optimal", False) else "否",
                "是否代理": "是" if job.get("proxyJob", False) else "否",
                "是否屏蔽": "是" if job.get("isShield", False) else "否",
                "是否直接投递": "是" if job.get("atsDirectPost", False) else "否",
                
                # 图标和标识
                "图标文字": job.get("iconWord", ""),
                "是否置顶": "是" if job.get("showTopPosition", False) else "否",
            }
            
            organized_jobs.append(job_info)
        
        return organized_jobs
        
    except Exception as e:
        print(f"提取工作数据时出错: {e}")
        return []

def write_jobs_to_csv(job_list, filename="boss_jobs.csv", mode="a"):
    """
    将工作信息列表写入CSV文件
    
    Args:
        job_list (list): 工作信息列表
        filename (str): CSV文件名
        mode (str): 写入模式，"w"为覆盖，"a"为追加
        
    Returns:
        bool: 是否写入成功
    """
    try:
        if not job_list:
            print("工作列表为空，无法写入CSV")
            return False
        
        # 获取表头（使用第一个工作的键作为表头）
        fieldnames = list(job_list[0].keys())
        
        # 检查文件是否存在，如果不存在则写入表头
        file_exists = os.path.exists(filename)
        
        # 写入CSV文件
        with open(filename, mode, newline='', encoding='utf-8-sig') as csvfile:
            writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
            
            # 如果文件不存在，写入表头
            if not file_exists or mode == "w":
                writer.writeheader()
            
            # 写入数据
            for job in job_list:
                writer.writerow(job)
        
        print(f"成功写入 {len(job_list)} 条工作信息到 {filename}")
        return True
        
    except Exception as e:
        print(f"写入CSV文件时出错: {e}")
        return False

def crawl_all_pages_with_hasmore(page_size=30, csv_filename="boss_jobs.csv"):
    """
    基于hasMore字段的智能翻页爬取（带自动异常处理）
    
    Args:
        page_size (int): 每页数量
        csv_filename (str): CSV文件名
        
    Returns:
        int: 成功爬取的页面数量
    """
    page = 1
    successful_pages = 0
    total_jobs = 0
    
    print(f"开始智能翻页爬取，每页 {page_size} 条...")
    
    while True:
        print(f"\n正在爬取第 {page} 页...")
        
        # 构建当前页面的URL
        current_url = build_job_list_url(page=page, pageSize=page_size)
        
        # 获取页面数据
        job_data = get_job_list(current_url)
        
        # 检查是否出现访问异常
        if check_access_anomaly(job_data):
            print("检测到访问行为异常，开始自动处理...")
            
            # 自动处理异常
            if handle_access_anomaly():
                print("异常处理完成，重新尝试当前页面...")
                # 重新获取当前页面数据
                job_data = get_job_list(current_url)
                
                # 再次检查异常
                if check_access_anomaly(job_data):
                    print("重试后仍然出现异常，跳过当前页面")
                    page += 1
                    continue
            else:
                print("异常处理失败，跳过当前页面")
                page += 1
                continue
        
        # 获取分页信息
        pagination_info = get_pagination_info(job_data)
        if pagination_info:
            print(f"页面信息: hasMore={pagination_info['hasMore']}, "
                  f"当前页职位数={pagination_info['jobListCount']}")
        
        # 提取工作数据
        organized_jobs = extract_job_data(job_data)
        
        if organized_jobs:
            # 写入CSV文件（追加模式）
            if write_jobs_to_csv(organized_jobs, csv_filename, mode="a"):
                successful_pages += 1
                total_jobs += len(organized_jobs)
                print(f"第 {page} 页爬取成功，获取 {len(organized_jobs)} 条工作信息")
            else:
                print(f"第 {page} 页写入CSV失败")
        else:
            print(f"第 {page} 页没有获取到工作信息")
        
        # 检查是否还有更多页面
        if pagination_info and not pagination_info['hasMore']:
            print(f"\n已到达最后一页，hasMore={pagination_info['hasMore']}")
            break
        
        # 添加延迟，避免请求过于频繁
        time.sleep(2)
        page += 1
    
    print(f"\n爬取完成！成功爬取 {successful_pages} 页，总计 {total_jobs} 条工作信息")
    return successful_pages

# 打开BOSS直聘
tab.get("https://www.zhipin.com/")

islogin = input("请输入是否登录(y/n):")
if islogin == "y":
    print("开始基于hasMore字段的智能翻页爬取...")
    crawl_all_pages_with_hasmore()
else:
    print("请先登录")

